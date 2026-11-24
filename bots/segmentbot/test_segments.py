import numpy as np
import pytest

import segments
from segments import Timeseries

RATE = 10.0  # frames per second


def series(rows: int, frames: int, fill) -> Timeseries:
    return Timeseries(np.array([[fill(r, f) for f in range(frames)] for r in range(rows)], np.float32), RATE)


def test_frames_inside_a_segment():
    t = series(1, 100, lambda r, f: f)
    assert t.frame_range(1.0, 0.5) == (10, 15)
    assert t.frame_range(1.01, 0.0) == (10, 11)  # always at least one frame
    assert t.frame_range(9.95, 1.0) == (99, 100)  # clipped to the data
    assert t.frame_range(20.0, 1.0) is None
    shifted = Timeseries(t.frames, RATE, start_seconds=1.0)
    assert shifted.frame_range(1.0, 0.5) == (0, 5)


def test_vectors_are_two_unit_halves():
    chroma = series(12, 50, lambda r, f: 1.0 if r == 9 else 0.1)
    mfcc = series(13, 50, lambda r, f: r - 6.0)
    v = np.array(segments.vector(chroma, mfcc, 0.5, 1.0))
    assert v.shape == (segments.DIM,)
    assert np.linalg.norm(v[:12]) == pytest.approx(1, abs=1e-5)
    assert np.linalg.norm(v[12:]) == pytest.approx(1, abs=1e-5)
    assert int(np.argmax(v[:12])) == 9


def test_annotations_follow_their_onsets_and_skip_silence():
    chroma = series(12, 50, lambda r, f: 0.0 if f < 10 else 1.0)  # silent for the first second
    mfcc = series(13, 50, lambda r, f: 1.0)
    onsets = [{"id": 7, "start_seconds": 0.0, "duration_seconds": 0.5},
              {"id": 8, "start_seconds": 2.0, "duration_seconds": 1.5}]
    bodies, skipped = segments.annotations(onsets, chroma, mfcc)
    assert skipped == 1
    assert bodies == [{"schema": segments.SCHEMA, "start_seconds": 2.0, "duration_seconds": 1.5,
                       "vector": bodies[0]["vector"], "data": {"onset": 8}}]
