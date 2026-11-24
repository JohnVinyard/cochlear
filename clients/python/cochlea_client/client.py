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

Re-runnable ingestion: `ensure_schema` and `sync_annotations` only create
what isn't there yet (see `content_key`).

PLACEHOLDER: no retries/backoff, no blob helpers beyond `upload_blob`.
"""

from __future__ import annotations

import hashlib
import json
import struct
import time
from collections import Counter
from dataclasses import dataclass
from typing import Any, Callable, Iterator, Literal, Optional, Sequence, Union

import requests

# None: only you;  "*": any authenticated user;  [ids]: these users (and you)
Access = Union[None, Literal["*"], Sequence[int]]


class ApiError(Exception):
    def __init__(self, status: int, errors: list[str]):
        super().__init__(f"HTTP {status}: {'; '.join(errors)}")
        self.status = status
        self.errors = errors


VALUE_FIELDS = ("tags", "text", "vector", "kv", "blob")
MAX_BATCH = 500


def _canonical_number(x: float) -> Union[int, float]:
    # the API is JavaScript: 4.0 goes in, 4 comes out
    return int(x) if isinstance(x, float) and x.is_integer() else x


def _canonical(value: Any) -> Any:
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return _canonical_number(value)
    if isinstance(value, dict):
        return {k: _canonical(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_canonical(v) for v in value]
    raise TypeError(f"not JSON-serialisable: {value!r}")


def _float32(x: float) -> float:
    return struct.unpack("f", struct.pack("f", x))[0]


def content_key(annotation: dict) -> str:
    """
    A stable hash of what an annotation *says*: its schema, segment, value and
    `data`. Not its id, creator, timestamps or `access`.

    It works on both the dict you POST and the resource the API returns, so
    "is this annotation already there?" can be answered by comparing keys.
    Normalisation mirrors what a round trip through the API does:

    - integral floats become ints (`4.0` -> `4`), since JavaScript has one number type
    - vectors are rounded to float32, which is how pgvector stores them
    - tags are trimmed and de-duplicated, in order, as the API does
    - object keys are sorted
    """
    start = annotation.get("start_seconds")
    duration = annotation.get("duration_seconds")
    identity: dict[str, Any] = {
        "schema": annotation["schema"],
        "segment": None if start is None else [start, duration],
        "data": annotation.get("data"),
    }
    for field in VALUE_FIELDS:
        value = annotation.get(field)
        if value is None:
            continue
        if field == "tags":
            value = list(dict.fromkeys(t.strip() for t in value))
        elif field == "vector":
            value = [_float32(x) for x in value]
        identity[field] = value
    blob = identity.get("blob")
    if blob:
        identity["blob"] = {"url": blob["url"], "content_type": blob["content_type"]}
    encoded = json.dumps(_canonical(identity), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


@dataclass
class SyncResult:
    created: int = 0
    existing: int = 0

    def __iadd__(self, other: "SyncResult") -> "SyncResult":
        self.created += other.created
        self.existing += other.existing
        return self


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

    @property
    def my_id(self) -> int:
        if not hasattr(self, "_my_id"):
            self._my_id = self.me()["id"]
        return self._my_id

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

    def ensure_schema(
        self,
        ref: str,
        kind: str,
        *,
        vector_dim: Optional[int] = None,
        json_schema: Optional[dict] = None,
        description: str = "",
    ) -> dict:
        """
        Returns the annotation schema `name@version`, creating it if it doesn't
        exist yet. Schemas are immutable: if it exists but differs, this raises
        rather than silently using something else, so bump the version.
        """
        name, version = ref.split("@")
        try:
            schema = self.get_schema(ref)
        except ApiError as e:
            if e.status != 404:
                raise
            body = {"name": name, "kind": kind, "vector_dim": vector_dim, "json_schema": json_schema,
                    "description": description}
            schema = self.request("POST", "/annotation-schemas", json=body)
            if schema["version"] != int(version):
                raise RuntimeError(
                    f"asked for {ref}, but the API created {name}@{schema['version']}; "
                    f"earlier versions of {name} exist"
                ) from None
            return schema
        actual = (schema["kind"], schema.get("vector_dim"), schema.get("json_schema"))
        if _canonical(list(actual)) != _canonical([kind, vector_dim, json_schema]):
            raise RuntimeError(
                f"schema {ref} already exists with kind={actual[0]}, vector_dim={actual[1]}, "
                f"json_schema={json.dumps(actual[2])}; schemas are immutable, so use a new version"
            )
        return schema

    def sync_annotations(
        self,
        sound_id: int,
        annotations: Sequence[dict],
        *,
        access: Access,
        on_batch: Optional[Callable[[int], None]] = None,
    ) -> SyncResult:
        """
        Makes sure every annotation in `annotations` exists on the sound,
        created by you. Ones already there (same `content_key`) are skipped;
        the rest are created in batches of 500. Running it again with the same
        input creates nothing, which makes ingestion scripts re-runnable,
        including after a crash part-way through.

        Matching is a multiset: two identical annotations in the input need
        two identical ones on the server. `access` isn't part of the content,
        so changing it doesn't create new annotations. Annotations you've
        deleted aren't in the feed, so they will be created again.

        Not safe against a *concurrent* run for the same sound, which can
        create duplicates.
        """
        existing = Counter(
            content_key(a)
            for a in self.feed_annotations(sound_id=sound_id, created_by=self.my_id, page_size=MAX_BATCH)
        )
        missing = []
        for a in annotations:
            key = content_key(a)
            if existing[key]:
                existing[key] -= 1
            else:
                missing.append(a)
        for i in range(0, len(missing), MAX_BATCH):
            batch = missing[i : i + MAX_BATCH]
            self.create_annotations(sound_id, batch, access=access)
            if on_batch:
                on_batch(len(batch))
        return SyncResult(created=len(missing), existing=len(annotations) - len(missing))

    def upload_blob(self, data: bytes, content_type: str = "application/x-npz") -> str:
        """Uploads bytes (e.g. an .npz of features), returning a URL for a blob annotation"""
        return self.request("POST", "/blobs", data=data, headers={"Content-Type": content_type})["url"]

    def delete_annotation(self, annotation_id: int) -> None:
        self.request("DELETE", f"/annotations/{annotation_id}")
