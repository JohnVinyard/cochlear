"""
featurebot: follows the sound feed and annotates every sound with its
onsets, and with frame-level chroma and MFCCs (see features.py).

    COCHLEA_API_KEY=cka_... python bots/featurebot/featurebot.py [--once] [--limit N]

It runs as its own bot user, and keeps its place in the feed in that user's
state document (GET/PUT /v1/users/me/state):

    {"features": "1", "sounds_cursor": 878, "processed": 503, "failed": 2,
     "recent_failures": [{"sound_id": 12, "audio_url": "...", "error": "...", "at": "..."}]}

so `yarn cli clear-data` resets it too, and the bot starts over. Each sound's
annotations are written with `sync_annotations`, so a sound that was
interrupted half-way is finished, not duplicated, when it's retried. State
writes are conditional (If-Match): if another instance, or a clear-data, got
there first, the bot re-reads its state and carries on from there.

Audio is fetched from each sound's audio_url, unless a --mirror maps the URL
to a local file:

    --mirror 'https://music-net.s3.us-east-1.amazonaws.com/=/audio/musicnet/train_data/{}.wav'

(`{}` is the rest of the URL). Several mirrors may share a prefix; the first
one whose file exists wins.

Failures:
  - a sound that can't be fetched (4xx), decoded, or is too long is recorded
    in recent_failures and skipped: retrying won't help;
  - network errors, 5xx and 429s are retried with backoff, indefinitely,
    without moving on, since the next sound would likely fail the same way;
  - an invalid API key (401) stops the bot.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

import requests

sys.path.insert(0, str(Path(__file__).parent))

import features  # noqa: E402
from cochlea_client import ApiError, CochleaClient, State, StateConflict  # noqa: E402

log = logging.getLogger("featurebot")

# Bump when the output changes: a new value starts the feed over, and each
# sound's annotations are replaced (sync_annotations(prune=True)). A change
# that existing readers can't handle needs new schema versions too.
# 2: data.timeseries on the chroma and MFCC blobs
# 3: chroma@2 and mfcc@2: float16, compressed
FEATURES_VERSION = "3"
RECENT_FAILURES = 20
BAD_KEY = ("the API key was rejected (401). If the database was recreated, delete the key file "
           "(.data/bots/featurebot.key) and restart, to issue a new one.")


class Permanent(Exception):
    """This sound can't be processed; record it and move on"""


class Fatal(Exception):
    """The bot can't continue (e.g. its API key is invalid)"""


# ---------------------------------------------------------------------------
# fetching audio
# ---------------------------------------------------------------------------

@dataclass
class Mirror:
    prefix: str
    template: str

    @classmethod
    def parse(cls, spec: str) -> "Mirror":
        prefix, sep, template = spec.partition("=")
        if not sep or not prefix or not template:
            raise argparse.ArgumentTypeError(f"--mirror must look like PREFIX=PATH_TEMPLATE, not {spec!r}")
        return cls(prefix, template)

    def path_for(self, url: str) -> Optional[Path]:
        if not url.startswith(self.prefix):
            return None
        rest = url[len(self.prefix):].split("?")[0]
        if ".." in rest.split("/"):
            return None
        return Path(self.template.replace("{}", rest) if "{}" in self.template else self.template + rest)


def fetch(url: str, dest: Path, mirrors: list[Mirror], max_bytes: int, timeout: float = 60) -> Path:
    """A local path for the audio at `url`: a mirrored file, or a download into `dest`"""
    for m in mirrors:
        path = m.path_for(url)
        if path is not None and path.is_file():
            return path
    try:
        with requests.get(url, stream=True, timeout=timeout) as resp:
            if resp.status_code == 429 or resp.status_code >= 500:
                raise ConnectionError(f"HTTP {resp.status_code} fetching {url}")
            if not resp.ok:
                raise Permanent(f"HTTP {resp.status_code} fetching {url}")
            if int(resp.headers.get("Content-Length") or 0) > max_bytes:
                raise Permanent(f"{url} is larger than {max_bytes} bytes")
            path = dest / "audio"
            size = 0
            with open(path, "wb") as f:
                for chunk in resp.iter_content(1 << 20):
                    size += len(chunk)
                    if size > max_bytes:
                        raise Permanent(f"{url} is larger than {max_bytes} bytes")
                    f.write(chunk)
            return path
    except requests.exceptions.InvalidURL as e:
        raise Permanent(f"invalid URL {url}: {e}") from e
    except requests.exceptions.RequestException as e:
        raise ConnectionError(f"fetching {url}: {e}") from e


def default_extract(path: Path) -> features.Features:
    try:
        y = features.load(str(path))
    except Exception as e:  # soundfile/audioread raise all sorts
        raise Permanent(f"couldn't decode the audio: {type(e).__name__}: {e}") from e
    return features.extract(y)


# ---------------------------------------------------------------------------
# the bot
# ---------------------------------------------------------------------------

@dataclass
class Options:
    mirrors: list[Mirror]
    max_duration_seconds: float = 3 * 3600
    max_bytes: int = 4 << 30
    poll_seconds: float = 30
    backoff_seconds: float = 5
    max_backoff_seconds: float = 300


class FeatureBot:
    def __init__(self, client: CochleaClient, options: Options,
                 extract: Callable[[Path], features.Features] = default_extract,
                 sleep: Callable[[float], None] = time.sleep):
        self.client = client
        self.options = options
        self.extract = extract
        self.sleep = sleep
        self.state: State = State({}, "")

    # -- state --------------------------------------------------------------

    def load_state(self) -> None:
        self.state = self.client.get_state()
        doc = self.state.document
        if doc.get("features") != FEATURES_VERSION:
            if doc:
                log.info("state is for features %r, not %r: starting the feed over", doc.get("features"),
                         FEATURES_VERSION)
            self.state.document = {"features": FEATURES_VERSION, "sounds_cursor": None, "processed": 0,
                                   "failed": 0, "recent_failures": []}

    @property
    def cursor(self) -> Optional[int]:
        return self.state.document.get("sounds_cursor")

    def save_state(self, update: Callable[[dict], None]) -> bool:
        """Applies `update` to the state and writes it. False if someone else wrote it first."""
        doc = dict(self.state.document)
        update(doc)
        try:
            self.state = self.client.put_state(doc, if_match=self.state.etag or None)
            return True
        except StateConflict:
            log.warning("state was changed elsewhere (another instance, or clear-data); re-reading it")
            self.load_state()
            return False

    # -- processing ---------------------------------------------------------

    def annotate(self, sound: dict) -> int:
        """Annotates one sound; returns how many annotations were created"""
        duration = sound["duration_seconds"]
        if duration > self.options.max_duration_seconds:
            raise Permanent(f"{duration:.0f}s is longer than --max-duration-seconds "
                            f"({self.options.max_duration_seconds:.0f})")
        with tempfile.TemporaryDirectory(prefix="featurebot-") as tmp:
            path = fetch(sound["audio_url"], Path(tmp), self.options.mirrors, self.options.max_bytes)
            extracted = self.extract(path)
        try:
            bodies = features.annotations(extracted, duration, upload=self.client.upload_blob)
            # prune: these are all of featurebot's annotations on the sound, so older output goes
            result = self.client.sync_annotations(sound["id"], bodies, access="*", prune=True)
        except ApiError as e:
            if e.status == 401:
                raise Fatal(BAD_KEY) from e
            if e.status in (404, 410):
                raise Permanent(f"the sound was deleted ({e.status})") from e
            if e.status == 429 or e.status >= 500:
                raise ConnectionError(str(e)) from e
            raise Permanent(f"the API rejected the annotations: {e}") from e
        if result.deleted:
            log.info("sound %d: replaced %d older annotations", sound["id"], result.deleted)
        return result.created

    def process(self, sound: dict) -> None:
        """Annotates a sound, retrying transient errors, and records the outcome"""
        backoff = self.options.backoff_seconds
        while True:
            try:
                started = time.monotonic()
                created = self.annotate(sound)
                log.info("sound %d: %d annotations created (%.1fs)", sound["id"], created,
                         time.monotonic() - started)
                failure = None
                break
            except Permanent as e:
                log.warning("sound %d: skipped: %s", sound["id"], e)
                failure = {"sound_id": sound["id"], "audio_url": sound["audio_url"], "error": str(e),
                           "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
                break
            except (ConnectionError, requests.exceptions.RequestException) as e:
                log.warning("sound %d: %s; retrying in %.0fs", sound["id"], e, backoff)
                self.sleep(backoff)
                backoff = min(backoff * 2, self.options.max_backoff_seconds)

        def update(doc: dict) -> None:
            doc["sounds_cursor"] = sound["id"]
            if failure:
                doc["failed"] = doc.get("failed", 0) + 1
                doc["recent_failures"] = (doc.get("recent_failures", []) + [failure])[-RECENT_FAILURES:]
            else:
                doc["processed"] = doc.get("processed", 0) + 1

        self.save_state(update)

    def drain(self, limit: Optional[int] = None) -> int:
        """Processes every sound after the cursor; returns how many it processed"""
        done = 0
        while True:
            cursor = self.cursor
            restarted = False
            for sound in self.client.feed_sounds(low_id=cursor, page_size=100):
                if limit is not None and done >= limit:
                    return done
                self.process(sound)
                done += 1
                if self.cursor != sound["id"]:
                    restarted = True  # the state changed under us: follow its cursor instead
                    break
            if not restarted:
                return done

    def ensure_schemas(self) -> None:
        for ref, (kind, dim, description) in features.SCHEMAS.items():
            self.client.ensure_schema(ref, kind, vector_dim=dim, description=description)

    def run(self, once: bool = False, limit: Optional[int] = None) -> None:
        backoff = self.options.backoff_seconds
        started = False
        while True:
            try:
                if not started:
                    self.ensure_schemas()
                    self.load_state()
                    log.info("starting after sound %s", self.cursor)
                    started = True
                done = self.drain(limit)
                if once or limit is not None:
                    log.info("processed %d sounds; stopping", done)
                    return
                backoff = self.options.backoff_seconds
                self.sleep(self.options.poll_seconds)
                self.load_state()  # picks up a clear-data while idle
            except ApiError as e:
                if e.status == 401:
                    raise Fatal(BAD_KEY) from e
                if not (e.status == 429 or e.status >= 500):
                    raise
                log.warning("API error: %s; retrying in %.0fs", e, backoff)
            except (ConnectionError, requests.exceptions.RequestException) as e:
                log.warning("can't reach the API: %s; retrying in %.0fs", e, backoff)
            self.sleep(backoff)
            backoff = min(backoff * 2, self.options.max_backoff_seconds)
            if started:
                self.load_state()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    p.add_argument("--api-url", default=os.environ.get("COCHLEA_API_URL", "http://localhost:8080/v1"))
    p.add_argument("--api-key", default=os.environ.get("COCHLEA_API_KEY"),
                   help="or COCHLEA_API_KEY, or a file in COCHLEA_API_KEY_FILE")
    p.add_argument("--mirror", type=Mirror.parse, action="append", default=[],
                   help="PREFIX=PATH_TEMPLATE; repeatable. Also FEATUREBOT_MIRRORS (';'-separated).")
    p.add_argument("--once", action="store_true", help="process what's in the feed, then exit")
    p.add_argument("--limit", type=int, help="process at most N sounds, then exit")
    p.add_argument("--poll-seconds", type=float, default=float(os.environ.get("FEATUREBOT_POLL_SECONDS", 30)))
    p.add_argument("--max-duration-seconds", type=float, default=3 * 3600, help="skip longer sounds")
    args = p.parse_args(argv)
    if not args.api_key and os.environ.get("COCHLEA_API_KEY_FILE"):
        args.api_key = Path(os.environ["COCHLEA_API_KEY_FILE"]).read_text().strip()
    if not args.api_key:
        p.error("an API key is required: --api-key, COCHLEA_API_KEY or COCHLEA_API_KEY_FILE")
    args.mirror += [Mirror.parse(m) for m in os.environ.get("FEATUREBOT_MIRRORS", "").split(";") if m.strip()]
    return args


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    args = parse_args(argv)
    client = CochleaClient(args.api_url, args.api_key)
    options = Options(mirrors=args.mirror, poll_seconds=args.poll_seconds,
                      max_duration_seconds=args.max_duration_seconds)
    for m in options.mirrors:
        log.info("mirror: %s -> %s", m.prefix, m.template)
    try:
        FeatureBot(client, options).run(once=args.once, limit=args.limit)
    except Fatal as e:
        log.error("%s", e)
        return 2
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
