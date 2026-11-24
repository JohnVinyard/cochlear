"""
segmentbot: follows featurebot's onset annotations, and gives each onset
segment a vector (see segments.py) for similarity search.

    COCHLEA_API_KEY=cka_... python bots/segmentbot/segmentbot.py [--once] [--limit N]

It reads the onset feed (GET /v1/annotations?schema=featurebot-onset@1,
created by that schema's creator), in runs of consecutive onsets on the same
sound. For each run it fetches the sound's chroma and MFCC blobs (once per
sound), and writes one vector annotation per onset, with sync_annotations,
so a run that was interrupted is finished, not duplicated.

featurebot writes a sound's onsets before its feature blobs, so the blobs may
not exist yet when segmentbot sees the onsets. It waits for them (retrying
with backoff, without moving on), for up to --max-wait-seconds, after which
it records the run as a failure and skips it.

State, in the bot user's state document (botkit):

    {"version": "1", "cursor": <last onset annotation id handled>, "processed": ..., "failed": ...,
     "recent_failures": [...]}
"""

from __future__ import annotations

import argparse
import io
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Optional

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

import botkit  # noqa: E402
import segments  # noqa: E402
from botkit import FeedBot, Item, Permanent  # noqa: E402,F401
from cochlea_client import ApiError, CochleaClient  # noqa: E402
from segments import Timeseries  # noqa: E402

#: the most onsets handled as one item (one sync_annotations call)
MAX_RUN = 2000


@dataclass
class Options:
    onset_schema: str = "featurebot-onset@1"
    chroma_schema: str = "featurebot-chroma@2"
    mfcc_schema: str = "featurebot-mfcc@2"
    max_wait_seconds: float = 3600
    poll_seconds: float = 30
    backoff_seconds: float = 5
    max_backoff_seconds: float = 300


def load_timeseries(annotation: dict, npz: bytes) -> Timeseries:
    """A blob annotation that follows the time series convention, as frames"""
    t = (annotation.get("data") or {}).get("timeseries")
    if not t or not t.get("frame_rate"):
        raise Permanent(f"annotation {annotation['id']} ({annotation['schema']}) has no data.timeseries")
    arrays = np.load(io.BytesIO(npz))
    name = t.get("array") or arrays.files[0]
    frames = arrays[name]
    if frames.ndim != 2:
        raise Permanent(f"annotation {annotation['id']}: expected a 2-d array, not {frames.shape}")
    offset = (annotation.get("start_seconds") or 0) + (t.get("start_seconds") or 0)
    return Timeseries(frames.astype(np.float32), float(t["frame_rate"]), offset)


class SegmentBot(FeedBot):
    name = "segmentbot"
    version = "1"

    def __init__(self, client: CochleaClient, options: Options = Options(),
                 sleep: Callable[[float], None] = time.sleep, clock: Callable[[], float] = time.monotonic):
        super().__init__(client, poll_seconds=options.poll_seconds, backoff_seconds=options.backoff_seconds,
                         max_backoff_seconds=options.max_backoff_seconds, sleep=sleep)
        self.options = options
        self.clock = clock
        self.source: Optional[int] = None  # who made the onsets (and features) we trust
        self.features: dict[int, tuple[Timeseries, Timeseries]] = {}  # the last sound's, by sound id
        self.waiting_since: dict[int, float] = {}  # item cursor -> when we started waiting for its features

    def setup(self) -> None:
        self.client.ensure_schema(segments.SCHEMA, "vector", vector_dim=segments.DIM,
                                  description=segments.DESCRIPTION)
        try:
            # anyone can annotate with a schema; only follow the annotations its creator makes
            self.source = self.client.get_schema(self.options.onset_schema)["created_by"]
        except ApiError as e:
            if e.status == 404:
                raise ConnectionError(f"waiting for {self.options.onset_schema} to exist (is featurebot running?)")
            raise
        self.log.info("following %s by user %d", self.options.onset_schema, self.source)

    def items(self, cursor: Optional[int]) -> Iterator[Item]:
        run: list[dict] = []

        def item() -> Item:
            sid = run[0]["sound_id"]
            return Item(cursor=run[-1]["id"], label=f"sound {sid}, onsets {run[0]['id']}-{run[-1]['id']}",
                        payload=(sid, list(run)))

        for a in self.client.feed_annotations(low_id=cursor, schema=self.options.onset_schema,
                                              created_by=self.source, page_size=500):
            if run and (a["sound_id"] != run[0]["sound_id"] or len(run) >= MAX_RUN):
                yield item()
                run = []
            run.append(a)
        if run:
            yield item()

    def sound_features(self, sound_id: int) -> tuple[Timeseries, Timeseries] | None:
        """The sound's chroma and MFCC (the newest of each), or None if featurebot hasn't written them yet"""
        if sound_id in self.features:
            return self.features[sound_id]
        found = []
        for schema in (self.options.chroma_schema, self.options.mfcc_schema):
            blobs = list(self.client.feed_annotations(sound_id=sound_id, schema=schema, created_by=self.source))
            if not blobs:
                return None
            newest = blobs[-1]
            found.append(load_timeseries(newest, self.client.download_blob(newest["blob"]["url"])))
        self.features = {sound_id: (found[0], found[1])}  # one sound at a time: runs arrive in sound order
        return self.features[sound_id]

    def handle(self, item: Item) -> str:
        sound_id, onsets = item.payload
        features = self.sound_features(sound_id)
        if features is None:
            since = self.waiting_since.setdefault(item.cursor, self.clock())
            if self.clock() - since > self.options.max_wait_seconds:
                raise Permanent(f"featurebot's features for sound {sound_id} didn't appear within "
                                f"{self.options.max_wait_seconds:.0f}s")
            raise ConnectionError(f"waiting for featurebot's features for sound {sound_id}")
        self.waiting_since.pop(item.cursor, None)
        bodies, skipped = segments.annotations(onsets, *features)
        result = self.client.sync_annotations(sound_id, bodies, access="*") if bodies else None
        created = result.created if result else 0
        silent = f", {skipped} silent onsets skipped" if skipped else ""
        return f"{created} vectors created, {len(bodies) - created} existed{silent}"


def parse_args(argv: list[str]) -> tuple[argparse.ArgumentParser, argparse.Namespace]:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    botkit.add_common_args(p)
    p.add_argument("--max-wait-seconds", type=float, default=3600,
                   help="how long to wait for a sound's features before skipping its onsets")
    return p, p.parse_args(argv)


def main(argv: list[str]) -> int:
    botkit.configure_logging()
    p, args = parse_args(argv)
    client = botkit.client_from_args(p, args)
    options = Options(max_wait_seconds=args.max_wait_seconds, poll_seconds=args.poll_seconds)
    return botkit.run_main(SegmentBot(client, options), args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
