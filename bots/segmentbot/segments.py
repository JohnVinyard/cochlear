"""
The vectors segmentbot writes: pure functions, no I/O.

For each onset segment (featurebot-onset@1), the chroma and MFCC frames that
fall inside it (from featurebot's frame-level blobs) are averaged over time,
each average is scaled to unit length, and the two are concatenated:

    segmentbot-chroma-mfcc@1   vector, 25-d: [12 unit-norm chroma | 13 unit-norm MFCC]

so chroma (harmony) and MFCC (timbre) count equally in cosine distance, as
the whole vector's norm is always sqrt(2). Each vector annotation spans the
same time as its onset, and its data says which onset it came from.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

SCHEMA = "segmentbot-chroma-mfcc@1"
N_CHROMA = 12
N_MFCC = 13
DIM = N_CHROMA + N_MFCC
DESCRIPTION = ("Per onset segment (featurebot-onset@1): featurebot's frame-level chroma and MFCCs averaged over the "
               "segment, each scaled to unit length, then concatenated: [12 chroma | 13 MFCC]. data.onset is the "
               "onset annotation's id.")

#: below this, an average is treated as silence: it has no direction to compare
MIN_NORM = 1e-6


@dataclass
class Timeseries:
    """A frame-level feature, per the time series convention (time is the last axis)"""

    frames: np.ndarray  # (rows, frames)
    frame_rate: float
    #: when frame 0 is, from the start of the sound
    start_seconds: float = 0.0

    def frame_range(self, start: float, duration: float) -> tuple[int, int] | None:
        """The frames inside [start, start + duration): at least one, if the segment overlaps the data at all"""
        n = self.frames.shape[-1]
        first = math.floor((start - self.start_seconds) * self.frame_rate)
        last = math.ceil((start + duration - self.start_seconds) * self.frame_rate)
        first, last = max(0, first), min(n, max(last, first + 1))
        return (first, last) if first < last else None

    def mean(self, start: float, duration: float) -> np.ndarray | None:
        span = self.frame_range(start, duration)
        if span is None:
            return None
        return self.frames[:, span[0]:span[1]].astype(np.float64).mean(axis=1)


def unit(v: np.ndarray | None) -> np.ndarray | None:
    if v is None or not np.all(np.isfinite(v)):
        return None
    norm = float(np.linalg.norm(v))
    return v / norm if norm > MIN_NORM else None


def vector(chroma: Timeseries, mfcc: Timeseries, start: float, duration: float) -> list[float] | None:
    """The segment's vector, or None if it's silent or outside the features"""
    c, m = unit(chroma.mean(start, duration)), unit(mfcc.mean(start, duration))
    if c is None or m is None:
        return None
    return [float(round(x, 6)) for x in np.concatenate([c, m])]


def annotations(onsets: list[dict], chroma: Timeseries, mfcc: Timeseries) -> tuple[list[dict], int]:
    """Vector annotation bodies for onset annotations, and how many onsets were skipped"""
    bodies, skipped = [], 0
    for onset in onsets:
        start, duration = onset["start_seconds"], onset["duration_seconds"]
        v = vector(chroma, mfcc, start, duration)
        if v is None:
            skipped += 1
            continue
        bodies.append({"schema": SCHEMA, "start_seconds": start, "duration_seconds": duration, "vector": v,
                       "data": {"onset": onset["id"]}})
    return bodies, skipped
