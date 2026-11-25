from pathlib import Path

import numpy as np
import pytest
from cochlea_client import ApiError, State, StateConflict, SyncResult

import featurebot
from featurebot import FeatureBot, Mirror, Options, Permanent
from features import Features


class FakeApi:
    """Just enough of CochleaClient for the bot, with a versioned state document"""

    def __init__(self, sounds):
        self.sounds = sounds
        self.document, self.version = {}, 0
        self.synced = {}
        self.schemas = set()
        self.before_put = None  # hook: simulate someone else writing first
        self.failures = []  # exceptions to raise from sync_annotations, in order

    def upload_blob(self, data, content_type):
        return f"https://blobs.example/{len(data)}"

    def ensure_schema(self, ref, kind, **_):
        self.schemas.add(ref)

    def get_state(self):
        return State(dict(self.document), f'"{self.version}"')

    def put_state(self, document, *, if_match=None):
        if self.before_put:
            hook, self.before_put = self.before_put, None
            hook(self)
        if if_match and if_match != f'"{self.version}"':
            raise StateConflict(412, ["changed"])
        self.document, self.version = dict(document), self.version + 1
        return self.get_state()

    def feed_sounds(self, low_id=None, page_size=100):
        return iter([s for s in self.sounds if low_id is None or s["id"] > low_id])

    def sync_annotations(self, sound_id, bodies, *, access, prune=False):
        assert prune
        if self.failures:
            raise self.failures.pop(0)
        assert access == "*"
        self.synced[sound_id] = self.synced.get(sound_id, 0) + 1
        self.last_bodies = bodies
        return SyncResult(created=len(bodies), existing=0, deleted=0)


FEATURES = Features(1.0, [(0.1, 0.5), (0.5, 1.0)], np.ones((12, 4), np.float32), np.zeros((13, 4), np.float32))


@pytest.fixture
def audio_dir(tmp_path):
    for name in ("1", "2", "3", "bad"):
        (tmp_path / f"{name}.wav").write_bytes(b"RIFF")
    return tmp_path


def sound(i, name=None, duration=1.0):
    return {"id": i, "audio_url": f"https://audio.example/{name or i}", "duration_seconds": duration}


def bot(api, audio_dir, **options):
    def extract(path: Path):
        if path.name == "bad.wav":
            raise Permanent("couldn't decode the audio")
        return FEATURES

    mirror = Mirror("https://audio.example/", f"{audio_dir}/{{}}.wav")
    return FeatureBot(api, Options(mirrors=[mirror], **options), extract=extract, sleep=lambda s: None)


def test_annotates_every_sound_and_remembers_where_it_got_to(audio_dir):
    api = FakeApi([sound(1), sound(2), sound(3)])
    bot(api, audio_dir).run(once=True)
    assert api.synced == {1: 1, 2: 1, 3: 1}
    assert api.schemas == {"featurebot-onset@1", "featurebot-chroma@2", "featurebot-mfcc@2"}
    assert api.document["sounds_cursor"] == 3 and api.document["processed"] == 3
    assert [b["schema"] for b in api.last_bodies] == [
        "featurebot-onset@1", "featurebot-onset@1", "featurebot-chroma@2", "featurebot-mfcc@2"]

    # a new sound arrives: only it is processed
    api.sounds.append(sound(4, "1"))
    bot(api, audio_dir).run(once=True)
    assert api.synced == {1: 1, 2: 1, 3: 1, 4: 1}


def test_records_and_skips_sounds_it_cant_process(audio_dir):
    api = FakeApi([sound(1), sound(2, "bad"), sound(3, duration=99999), sound(4, "3")])
    bot(api, audio_dir, max_duration_seconds=3600).run(once=True)
    assert set(api.synced) == {1, 4}
    assert api.document["failed"] == 2
    errors = [f["error"] for f in api.document["recent_failures"]]
    assert "decode" in errors[0] and "longer than" in errors[1]


def test_retries_transient_errors_without_moving_on(audio_dir):
    api = FakeApi([sound(1)])
    api.failures = [ApiError(503, ["down"]), ConnectionError("reset")]
    bot(api, audio_dir).run(once=True)
    assert api.synced == {1: 1} and api.document["failed"] == 0


def test_an_invalid_key_stops_the_bot(audio_dir):
    api = FakeApi([sound(1)])
    api.failures = [ApiError(401, ["nope"])]
    with pytest.raises(featurebot.Fatal):
        bot(api, audio_dir).run(once=True)


def test_starts_over_when_its_state_is_cleared_under_it(audio_dir):
    api = FakeApi([sound(1), sound(2), sound(3)])
    bot(api, audio_dir).run(once=True)

    # clear-data resets the state (and bumps its version) while the bot is mid-run
    api.sounds.append(sound(4, "1"))
    api.before_put = lambda a: setattr(a, "document", {}) or setattr(a, "version", a.version + 1)
    bot(api, audio_dir).run(once=True)
    # sound 4's write lost the race; the bot re-read {} and went round from the start
    assert api.synced == {1: 2, 2: 2, 3: 2, 4: 2}
    assert api.document["sounds_cursor"] == 4 and api.document["processed"] == 4


def test_a_new_features_version_starts_the_feed_over(audio_dir, monkeypatch):
    api = FakeApi([sound(1)])
    bot(api, audio_dir).run(once=True)
    monkeypatch.setattr(featurebot, "FEATURES_VERSION", "99")
    bot(api, audio_dir).run(once=True)
    assert api.synced == {1: 2} and api.document["features"] == "99"


def test_limit(audio_dir):
    api = FakeApi([sound(1), sound(2), sound(3)])
    bot(api, audio_dir).run(limit=2)
    assert set(api.synced) == {1, 2} and api.document["sounds_cursor"] == 2


def test_mirrors_map_urls_to_files():
    m = Mirror("https://music-net.s3.us-east-1.amazonaws.com/", "/audio/train_data/{}.wav")
    assert m.path_for("https://music-net.s3.us-east-1.amazonaws.com/1727") == Path("/audio/train_data/1727.wav")
    assert m.path_for("https://elsewhere/1727") is None
    assert m.path_for("https://music-net.s3.us-east-1.amazonaws.com/../../etc/passwd") is None
    assert Mirror.parse("https://a/=/b/").path_for("https://a/x.wav") == Path("/b/x.wav")


# -- codec documents ------------------------------------------------------------

SPRS = "audio/vnd.cochlea.sprs+json"


def codec_doc(url="https://audio.example/source"):
    return {"format": "cochlea-codec", "version": "0.2", "root": {"type": "sequencer", "events": [
        {"time_seconds": 0, "node": {"type": "sampler", "url": url, "start_seconds": 1, "duration_seconds": 2}}]}}


def codec_sound(i, name, declared=True):
    s = sound(i, name, duration=2.0)
    s["formats"] = [{"url": s["audio_url"], "mime_type": SPRS}] if declared else []
    return s


def test_renders_codec_documents_and_annotates_them(audio_dir):
    import json

    (audio_dir / "doc.wav").write_text(json.dumps(codec_doc()))
    (audio_dir / "sniffed.wav").write_text(json.dumps(codec_doc()))
    rendered, analysed = [], []

    def render(document, url):
        rendered.append((document["root"]["events"][0]["node"]["url"], url))
        return np.zeros(100, np.float32)

    def extract_samples(y):
        analysed.append(len(y))
        return FEATURES

    api = FakeApi([codec_sound(1, "doc"), codec_sound(2, "sniffed", declared=False), sound(3)])
    b = bot(api, audio_dir)
    b.render, b.extract_samples = render, extract_samples
    b.run(once=True)
    # both documents were rendered (the second recognised by its content), the WAV wasn't
    assert rendered == [("https://audio.example/source", "https://audio.example/doc"),
                        ("https://audio.example/source", "https://audio.example/sniffed")]
    assert analysed == [100, 100]
    assert set(api.synced) == {1, 2, 3}


def test_a_sound_that_says_its_a_codec_document_but_isnt_is_skipped(audio_dir):
    api = FakeApi([codec_sound(1, "1")])  # 1.wav is (the start of) a WAV
    bot(api, audio_dir).run(once=True)
    assert api.document["failed"] == 1
    assert "isn't one" in api.document["recent_failures"][0]["error"]


def test_renders_a_codec_document_with_the_real_decoder(tmp_path):
    import json

    import soundfile
    from cochlea_client.codec import find_wasm

    if not find_wasm().is_file():
        pytest.skip("the codec decoder isn't built (yarn build-codec)")
    # the document plays 2 s from the middle of a mirrored 10 s sound: clicks, so there are onsets
    sr = 22050
    y = np.zeros(10 * sr, np.float32)
    y[np.arange(0, len(y), sr // 4)] = 1.0
    soundfile.write(tmp_path / "source.wav", y, sr)
    (tmp_path / "doc.wav").write_text(json.dumps(codec_doc()))
    api = FakeApi([codec_sound(1, "doc")])
    mirror = Mirror("https://audio.example/", f"{tmp_path}/{{}}.wav")
    FeatureBot(api, Options(mirrors=[mirror]), sleep=lambda s: None).run(once=True)
    assert api.document.get("failed", 0) == 0, api.document.get("recent_failures")
    onsets = [b for b in api.last_bodies if b["schema"].startswith("featurebot-onset")]
    assert 4 <= len(onsets) <= 10, len(onsets)  # about 8 clicks in 2 s
    assert all(b["start_seconds"] < 2.0 for b in onsets)
