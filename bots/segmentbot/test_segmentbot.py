import io

import numpy as np
import pytest
from cochlea_client import ApiError, State, SyncResult

import segmentbot
from segmentbot import Options, SegmentBot

FEATUREBOT = 5


def npz(**arrays) -> bytes:
    buf = io.BytesIO()
    np.savez_compressed(buf, **arrays)
    return buf.getvalue()


def blob(i, sound_id, schema, name, rows):
    return {"id": i, "sound_id": sound_id, "schema": schema, "start_seconds": None, "created_by": FEATUREBOT,
            "blob": {"url": f"https://blobs/{name}-{sound_id}"},
            "data": {"timeseries": {"array": name, "frame_rate": 10.0}}, "_rows": rows}


class FakeApi:
    def __init__(self):
        self.annotations = []
        self.blobs = {}
        self.document, self.version = {}, 0
        self.synced = []

    def onset(self, i, sound_id, start, duration=0.5, by=FEATUREBOT):
        self.annotations.append({"id": i, "sound_id": sound_id, "schema": "featurebot-onset@1", "created_by": by,
                                 "start_seconds": start, "duration_seconds": duration})

    def features(self, sound_id, first_id):
        for i, (schema, name, rows) in enumerate((("featurebot-chroma@2", "chroma", 12),
                                                  ("featurebot-mfcc@2", "mfcc", 13))):
            b = blob(first_id + i, sound_id, schema, name, rows)
            self.annotations.append(b)
            self.blobs[b["blob"]["url"]] = npz(**{name: np.random.default_rng(sound_id).random((rows, 100)).astype(np.float16)})

    # -- the client ------------------------------------------------------------
    def ensure_schema(self, *a, **k): pass

    def get_schema(self, ref):
        return {"ref": ref, "created_by": FEATUREBOT}

    def get_state(self):
        return State(dict(self.document), f'"{self.version}"')

    def put_state(self, document, *, if_match=None):
        self.document, self.version = dict(document), self.version + 1
        return self.get_state()

    def feed_annotations(self, low_id=None, sound_id=None, schema=None, created_by=None, page_size=100):
        return iter([a for a in sorted(self.annotations, key=lambda a: a["id"])
                     if (low_id is None or a["id"] > low_id) and (sound_id is None or a["sound_id"] == sound_id)
                     and (schema is None or a["schema"] == schema) and (created_by is None or a["created_by"] == created_by)])

    def download_blob(self, url):
        return self.blobs[url]

    def sync_annotations(self, sound_id, bodies, *, access):
        self.synced.append((sound_id, [b["data"]["onset"] for b in bodies]))
        return SyncResult(created=len(bodies))


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def bot(api, clock=None, **options):
    clock = clock or Clock()
    return SegmentBot(api, Options(**options), sleep=lambda s: setattr(clock, "now", clock.now + s), clock=clock)


def test_one_vector_per_onset_in_runs_per_sound():
    api = FakeApi()
    for i, sid, start in ((1, 10, 0.0), (2, 10, 0.5), (3, 11, 0.0), (4, 10, 1.0)):
        api.onset(i, sid, start)
    api.onset(5, 10, 2.0, by=99)  # not featurebot's: ignored
    api.features(10, 100)
    api.features(11, 200)
    bot(api).run(once=True)
    assert api.synced == [(10, [1, 2]), (11, [3]), (10, [4])]
    assert api.document["cursor"] == 4 and api.document["processed"] == 3


def test_waits_for_features_then_gives_up():
    api = FakeApi()
    api.onset(1, 10, 0.0)
    clock = Clock()

    # features appear while the bot waits: it carries on
    b = bot(api, clock, max_wait_seconds=60)
    original = b.sound_features
    calls = {"n": 0}

    def appearing(sound_id):
        calls["n"] += 1
        if calls["n"] == 3:
            api.features(10, 100)
        return original(sound_id)

    b.sound_features = appearing
    b.run(once=True)
    assert api.synced == [(10, [1])] and api.document["failed"] == 0

    # they never do: after max_wait_seconds it records the run and moves on
    api2 = FakeApi()
    api2.onset(1, 12, 0.0)
    bot(api2, Clock(), max_wait_seconds=60).run(once=True)
    assert api2.synced == [] and api2.document["failed"] == 1
    assert "didn't appear" in api2.document["recent_failures"][0]["error"]


def test_waits_for_featurebot_to_exist():
    api = FakeApi()
    calls = {"n": 0}

    def get_schema(ref):
        calls["n"] += 1
        if calls["n"] < 3:
            raise ApiError(404, ["no such schema"])
        return {"created_by": FEATUREBOT}

    api.get_schema = get_schema
    bot(api).run(once=True)
    assert calls["n"] == 3


def test_the_vectors_cover_their_onsets():
    api = FakeApi()
    api.onset(1, 10, 1.0, duration=2.0)
    api.features(10, 100)
    captured = {}
    api.sync_annotations = lambda sid, bodies, access: captured.setdefault("bodies", bodies) and SyncResult(1)
    bot(api).run(once=True)
    (body,) = captured["bodies"]
    assert (body["start_seconds"], body["duration_seconds"], len(body["vector"])) == (1.0, 2.0, 25)
