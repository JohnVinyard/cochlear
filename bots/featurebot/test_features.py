import io
import zipfile

import numpy as np
import pytest

import features

SR = features.SAMPLE_RATE
NOTE_TIMES = [0.5, 1.0, 1.5, 2.0]


def plucks(freq: float = 440.0, duration: float = 3.0) -> np.ndarray:
    """Decaying sine plucks at NOTE_TIMES, in near-silence"""
    t = np.arange(int(duration * SR)) / SR
    y = np.random.default_rng(0).normal(0, 1e-4, t.size)
    for start in NOTE_TIMES:
        tt = t - start
        y += np.where(tt >= 0, np.sin(2 * np.pi * freq * tt) * np.exp(-np.clip(tt, 0, None) * 8), 0)
    return y.astype(np.float32)


@pytest.fixture(scope="module")
def extracted():
    return features.extract(plucks())


class Blobs:
    def __init__(self):
        self.stored = {}

    def __call__(self, data: bytes, content_type: str) -> str:
        url = f"https://blobs.example/{len(self.stored)}"
        self.stored[url] = data
        return url


def test_finds_each_onset(extracted):
    assert [start for start, _ in extracted.onsets] == pytest.approx(NOTE_TIMES, abs=0.05)


def test_onsets_run_to_the_next_onset_then_to_the_end(extracted):
    for (_, end), (start, _) in zip(extracted.onsets, extracted.onsets[1:]):
        assert end == start
    assert extracted.onsets[-1][1] == pytest.approx(3.0)


def test_frame_level_features(extracted):
    frames = 1 + int(3.0 * SR) // features.HOP_LENGTH
    assert extracted.chroma.shape == (12, frames) and extracted.mfcc.shape == (13, frames)
    # during a note, A is the loudest pitch class
    frame = int(0.6 * SR / features.HOP_LENGTH)
    assert int(np.argmax(extracted.chroma[:, frame])) == 9


def test_annotations(extracted):
    blobs = Blobs()
    bodies = features.annotations(extracted, sound_duration_seconds=2.9, upload=blobs)
    onsets = [b for b in bodies if b["schema"] == features.ONSET_SCHEMA]
    assert len(onsets) == len(NOTE_TIMES)
    for b in onsets:
        assert set(b) == {"schema", "start_seconds", "duration_seconds", "tags"}
        assert b["start_seconds"] + b["duration_seconds"] <= 2.9 + 1e-9

    chroma, mfcc = bodies[-2:]
    assert (chroma["schema"], mfcc["schema"]) == (features.CHROMA_SCHEMA, features.MFCC_SCHEMA)
    assert "start_seconds" not in chroma  # the whole sound
    assert chroma["data"]["shape"] == list(extracted.chroma.shape)
    t = chroma["data"]["timeseries"]
    assert t["array"] == "chroma" and t["frame_rate"] == SR / 512 and t["rows"][9] == "A"
    assert mfcc["data"]["timeseries"]["normalize"] == "rows"
    stored = np.load(io.BytesIO(blobs.stored[chroma["blob"]["url"]]))
    assert stored["chroma"].dtype == np.float16
    np.testing.assert_allclose(stored["chroma"], extracted.chroma, atol=1e-3)
    zipped = zipfile.ZipFile(io.BytesIO(blobs.stored[chroma["blob"]["url"]]))
    assert all(info.compress_type == zipfile.ZIP_DEFLATED for info in zipped.infolist())


def test_silence_and_tiny_sounds():
    silent = features.extract(np.zeros(SR, dtype=np.float32))
    assert silent.onsets == [] and silent.chroma.shape[0] == 12
    assert features.annotations(features.extract(np.zeros(10, np.float32)), 1.0, Blobs()) == []


def test_is_deterministic_down_to_the_blob_bytes():
    a, b = Blobs(), Blobs()
    assert features.annotations(features.extract(plucks()), 3.0, a) == features.annotations(
        features.extract(plucks()), 3.0, b)
    assert list(a.stored.values()) == list(b.stored.values())
