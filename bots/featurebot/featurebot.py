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
import os
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Optional

import requests

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

import botkit  # noqa: E402
import features  # noqa: E402
from botkit import Fatal, FeedBot, Item, Permanent  # noqa: E402,F401
from cochlea_client import CochleaClient  # noqa: E402

# Bump when the output changes: a new value starts the feed over, and each
# sound's annotations are replaced (sync_annotations(prune=True)). A change
# that existing readers can't handle needs new schema versions too.
# 2: data.timeseries on the chroma and MFCC blobs
# 3: chroma@2 and mfcc@2: float16, compressed
FEATURES_VERSION = "3"


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


class FeatureBot(FeedBot):
    name = "featurebot"
    # the keys its state has always used
    version_key = "features"
    cursor_key = "sounds_cursor"

    def __init__(self, client: CochleaClient, options: Options,
                 extract: Callable[[Path], features.Features] = default_extract,
                 sleep: Callable[[float], None] = time.sleep):
        super().__init__(client, poll_seconds=options.poll_seconds, backoff_seconds=options.backoff_seconds,
                         max_backoff_seconds=options.max_backoff_seconds, sleep=sleep)
        self.options = options
        self.extract = extract

    @property
    def version(self) -> str:  # type: ignore[override]
        return FEATURES_VERSION

    def setup(self) -> None:
        for ref, (kind, dim, description) in features.SCHEMAS.items():
            self.client.ensure_schema(ref, kind, vector_dim=dim, description=description)

    def items(self, cursor: Optional[int]) -> Iterator[Item]:
        for sound in self.client.feed_sounds(low_id=cursor, page_size=100):
            yield Item(cursor=sound["id"], label=f"sound {sound['id']}", payload=sound)

    def failure(self, item: Item, error: Exception) -> dict:
        return {"sound_id": item.payload["id"], "audio_url": item.payload["audio_url"],
                **super().failure(item, error)}

    def handle(self, item: Item) -> str:
        sound = item.payload
        duration = sound["duration_seconds"]
        if duration > self.options.max_duration_seconds:
            raise Permanent(f"{duration:.0f}s is longer than --max-duration-seconds "
                            f"({self.options.max_duration_seconds:.0f})")
        with tempfile.TemporaryDirectory(prefix="featurebot-") as tmp:
            path = fetch(sound["audio_url"], Path(tmp), self.options.mirrors, self.options.max_bytes)
            extracted = self.extract(path)
        bodies = features.annotations(extracted, duration, upload=self.client.upload_blob)
        # prune: these are all of featurebot's annotations on the sound, so older output goes
        result = self.client.sync_annotations(sound["id"], bodies, access="*", prune=True)
        replaced = f", replaced {result.deleted} older ones" if result.deleted else ""
        return f"{result.created} annotations created{replaced}"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str]) -> tuple[argparse.ArgumentParser, argparse.Namespace]:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    botkit.add_common_args(p)
    p.add_argument("--mirror", type=Mirror.parse, action="append", default=[],
                   help="PREFIX=PATH_TEMPLATE; repeatable. Also FEATUREBOT_MIRRORS (';'-separated).")
    p.add_argument("--max-duration-seconds", type=float, default=3 * 3600, help="skip longer sounds")
    args = p.parse_args(argv)
    args.mirror += [Mirror.parse(m) for m in os.environ.get("FEATUREBOT_MIRRORS", "").split(";") if m.strip()]
    return p, args


def main(argv: list[str]) -> int:
    botkit.configure_logging()
    p, args = parse_args(argv)
    client = botkit.client_from_args(p, args)
    options = Options(mirrors=args.mirror, poll_seconds=args.poll_seconds,
                      max_duration_seconds=args.max_duration_seconds)
    bot = FeatureBot(client, options)
    for m in options.mirrors:
        bot.log.info("mirror: %s -> %s", m.prefix, m.template)
    return botkit.run_main(bot, args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
