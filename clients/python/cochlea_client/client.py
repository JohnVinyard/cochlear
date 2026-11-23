"""
A thin client for the Cochlea API.

    from cochlea_client import CochleaClient

    client = CochleaClient("http://localhost:8080/v1", api_key="cka_...")
    for sound in client.feed_sounds(low_id=last_seen_id):
        ...
        client.create_annotations(sound["id"], [
            {"schema": "tags@1", "tags": ["piano"]},
        ], access="*")
        last_seen_id = sound["id"]

Feeds are oldest-first and gap-free: a bot can persist the last id it has
processed and resume from it with `low_id`.

PLACEHOLDER: no retries/backoff, no blob helpers beyond `upload_blob`.
"""

from __future__ import annotations

import time
from typing import Any, Iterator, Literal, Optional, Sequence, Union

import requests

# None: only you;  "*": any authenticated user;  [ids]: these users (and you)
Access = Union[None, Literal["*"], Sequence[int]]


class ApiError(Exception):
    def __init__(self, status: int, errors: list[str]):
        super().__init__(f"HTTP {status}: {'; '.join(errors)}")
        self.status = status
        self.errors = errors


class CochleaClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        session: Optional[requests.Session] = None,
        timeout: float = 30,
    ):
        self.base_url = base_url.rstrip("/")
        self.session = session or requests.Session()
        self.session.headers["Authorization"] = f"Bearer {api_key}"
        self.timeout = timeout

    # -- plumbing -----------------------------------------------------------

    def _url(self, href_or_path: str) -> str:
        if href_or_path.startswith("http"):
            return href_or_path
        return self.base_url + href_or_path

    def request(self, method: str, href_or_path: str, **kwargs: Any) -> Any:
        resp = self.session.request(method, self._url(href_or_path), timeout=self.timeout, **kwargs)
        if resp.status_code == 204:
            return None
        body = resp.json() if resp.content else None
        if not resp.ok:
            raise ApiError(resp.status_code, (body or {}).get("errors", [resp.reason]))
        return body

    def get(self, href_or_path: str, **params: Any) -> Any:
        return self.request("GET", href_or_path, params={k: v for k, v in params.items() if v is not None})

    def _feed(
        self, path: str, follow: bool, poll_interval: float, **params: Any
    ) -> Iterator[dict]:
        """
        Yields every item in a feed, following `next` links. When `follow` is
        true, keeps polling for new items forever (like `tail -f`).
        """
        page = self.get(path, **params)
        last_id = params.get("low_id")
        while True:
            for item in page["items"]:
                last_id = item["id"]
                yield item
            if page.get("next"):
                page = self.get(page["next"])
            elif follow:
                time.sleep(poll_interval)
                page = self.get(path, **{**params, "low_id": last_id})
            else:
                return

    # -- resources ----------------------------------------------------------

    def me(self) -> dict:
        return self.get("/users/me")

    def feed_sounds(
        self,
        low_id: Optional[int] = None,
        created_by: Optional[int] = None,
        page_size: int = 100,
        follow: bool = False,
        poll_interval: float = 10,
    ) -> Iterator[dict]:
        return self._feed(
            "/sounds", follow, poll_interval, low_id=low_id, created_by=created_by, page_size=page_size
        )

    def feed_annotations(
        self,
        low_id: Optional[int] = None,
        sound_id: Optional[int] = None,
        schema: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
        created_by: Optional[int] = None,
        page_size: int = 100,
        follow: bool = False,
        poll_interval: float = 10,
    ) -> Iterator[dict]:
        path = f"/sounds/{sound_id}/annotations" if sound_id else "/annotations"
        return self._feed(
            path,
            follow,
            poll_interval,
            low_id=low_id,
            schema=schema,
            tags=",".join(tags) if tags else None,
            created_by=created_by,
            page_size=page_size,
        )

    def get_sound(self, sound_id: int) -> dict:
        return self.get(f"/sounds/{sound_id}")

    def get_annotation(self, annotation_id: int) -> dict:
        return self.get(f"/annotations/{annotation_id}")

    def get_schema(self, ref: str) -> dict:
        return self.get(f"/annotation-schemas/{ref}")

    def create_sound(
        self,
        audio_url: str,
        license_type: str,
        duration_seconds: float,
        title: Optional[str] = None,
        info_url: Optional[str] = None,
        low_quality_audio_url: Optional[str] = None,
        exist_ok: bool = True,
    ) -> dict:
        """
        Registers a sound. Sounds are unique by `audio_url`; with `exist_ok`
        (the default) re-registering returns the existing sound, which makes
        dataset ingestion scripts safely re-runnable.
        """
        body = {
            "audio_url": audio_url,
            "license_type": license_type,
            "duration_seconds": duration_seconds,
            "title": title,
            "info_url": info_url,
            "low_quality_audio_url": low_quality_audio_url,
        }
        resp = self.session.post(self._url("/sounds"), json=body, timeout=self.timeout)
        if resp.status_code == 409 and exist_ok and resp.headers.get("Location"):
            return self.get(resp.headers["Location"])
        if not resp.ok:
            raise ApiError(resp.status_code, resp.json().get("errors", []))
        return resp.json()

    def create_annotations(self, sound_id: int, annotations: Sequence[dict], *, access: Access) -> list[dict]:
        """
        Atomically creates up to 500 annotations. `access` is required
        (annotations are private by default, which is rarely what a bot
        wants); an individual annotation may still override it.
        """
        wire_access = list(access) if isinstance(access, (list, tuple)) else access
        body = {"annotations": [{"access": wire_access, **a} for a in annotations]}
        return self.request("POST", f"/sounds/{sound_id}/annotations", json=body)["items"]

    def upload_blob(self, data: bytes, content_type: str = "application/x-npz") -> str:
        """Uploads bytes (e.g. an .npz of features), returning a URL for a blob annotation"""
        return self.request("POST", "/blobs", data=data, headers={"Content-Type": content_type})["url"]

    def delete_annotation(self, annotation_id: int) -> None:
        self.request("DELETE", f"/annotations/{annotation_id}")
