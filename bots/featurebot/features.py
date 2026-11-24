"""
Feature extraction for featurebot: pure functions from audio to annotation
bodies, with no I/O of their own, so they can be tested on synthetic signals.

Per sound:

    featurebot-onset@1    tags  ["onset"], one per onset, spanning from that
                                onset to the next one (or the end of the sound)
    featurebot-chroma@2   blob  frame-level chroma, (12, frames) float16, as a compressed .npz
    featurebot-mfcc@2     blob  frame-level MFCCs, (13, frames) float16, as a compressed .npz

Onsets only describe where events start and stop. The chroma and MFCC
blobs cover the whole sound at frame resolution (22.05 kHz, hop 512, about
43 frames/s). Their `data` follows the time series convention
(docs/annotation-conventions.md), so viewers can draw them:

    {"sample_rate": 22050, "hop_length": 512, "shape": [12, frames],
     "timeseries": {"array": "chroma", "frame_rate": 43.07, "rows": ["C", ...], "range": [0, 1]}}

Frame i is at i * hop_length / sample_rate seconds. Summarising features over onset
segments (or anything else) is a job for another bot, built on these.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Callable

import numpy as np

SAMPLE_RATE = 22050
HOP_LENGTH = 512
N_MFCC = 13
N_CHROMA = 12
NPZ = "application/x-npz"

ONSET_SCHEMA = "featurebot-onset@1"
# @2: float16 in a compressed .npz (@1 was float32, uncompressed), about 2.8x smaller.
# float16's ~3 significant digits are more than these features carry.
CHROMA_SCHEMA = "featurebot-chroma@2"
MFCC_SCHEMA = "featurebot-mfcc@2"
STORED_DTYPE = np.float16

_FRAMES = (f"{SAMPLE_RATE} Hz, hop {HOP_LENGTH}; data gives sample_rate, hop_length and shape, and follows the "
           "time series convention (data.timeseries)")
FRAME_RATE = SAMPLE_RATE / HOP_LENGTH
PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# how to draw each (data.timeseries); MFCC rows have very different ranges
TIMESERIES = {
    "chroma": {"array": "chroma", "frame_rate": FRAME_RATE, "rows": PITCH_CLASSES, "range": [0, 1]},
    "mfcc": {"array": "mfcc", "frame_rate": FRAME_RATE, "rows": [f"c{i}" for i in range(N_MFCC)],
             "normalize": "rows"},
}

# ref -> (kind, vector_dim, description), for client.ensure_schema
SCHEMAS = {
    ONSET_SCHEMA: ("tags", None, "An onset (librosa.onset.onset_detect, backtracked), spanning from the onset to the "
                                 "next one, or to the end of the sound"),
    CHROMA_SCHEMA: ("blob", None, "Frame-level chroma for the whole sound (librosa.feature.chroma_stft): an .npz "
                                  f"(np.savez_compressed) with one float16 array, chroma, of shape (12, frames); C, C#, ..., B. {_FRAMES}"),
    MFCC_SCHEMA: ("blob", None, "Frame-level MFCCs for the whole sound (librosa.feature.mfcc, 13 coefficients "
                                f"including c0): an .npz (np.savez_compressed) with one float16 array, mfcc, of shape (13, frames). "
                                f"{_FRAMES}"),
}


@dataclass
class Features:
    duration_seconds: float
    #: (start_seconds, end_seconds) of each onset segment
    onsets: list[tuple[float, float]]
    chroma: np.ndarray  # (12, frames)
    mfcc: np.ndarray  # (13, frames)


def extract(y: np.ndarray, sr: int = SAMPLE_RATE) -> Features:
    """Onset segments and frame-level features of a mono signal"""
    import librosa  # slow to import; keep `import features` cheap

    duration = len(y) / sr
    if y.size < 2048:  # shorter than one analysis window
        return Features(duration, [], np.zeros((N_CHROMA, 0), np.float32), np.zeros((N_MFCC, 0), np.float32))
    chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=HOP_LENGTH).astype(np.float32)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, hop_length=HOP_LENGTH, n_mfcc=N_MFCC).astype(np.float32)

    envelope = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_LENGTH)
    peaks = librosa.onset.onset_detect(onset_envelope=envelope, sr=sr, hop_length=HOP_LENGTH, units="frames")
    # backtrack each peak to the preceding energy minimum, where the event starts;
    # two peaks can backtrack to the same frame
    starts = np.unique(librosa.onset.onset_backtrack(peaks, envelope)) if len(peaks) else np.array([], int)
    times = [float(t) for t in librosa.frames_to_time(starts, sr=sr, hop_length=HOP_LENGTH) if t < duration]
    onsets = [(t, times[i + 1] if i + 1 < len(times) else duration) for i, t in enumerate(times)]
    return Features(duration, onsets, chroma, mfcc)


def npz(**arrays: np.ndarray) -> bytes:
    """Deterministic .npz bytes (so the content-addressed blob URL is too)"""
    buf = io.BytesIO()
    np.savez_compressed(buf, **arrays)
    return buf.getvalue()


def _round(x: float) -> float:
    return float(round(float(x), 6))


def annotations(f: Features, sound_duration_seconds: float, upload: Callable[[bytes, str], str]) -> list[dict]:
    """
    Annotation bodies for `client.sync_annotations`. `upload(bytes,
    content_type)` stores a blob and returns its URL. Onsets are clipped to
    the sound's declared duration, which the API enforces (and which may
    differ slightly from the decoded audio's).
    """
    out = []
    for start, end in f.onsets:
        start, end = _round(start), _round(min(end, sound_duration_seconds))
        if end > start:
            out.append({"schema": ONSET_SCHEMA, "start_seconds": start, "duration_seconds": _round(end - start),
                        "tags": ["onset"]})
    if f.chroma.shape[1]:
        for schema, name, matrix in ((CHROMA_SCHEMA, "chroma", f.chroma), (MFCC_SCHEMA, "mfcc", f.mfcc)):
            out.append({
                "schema": schema,
                "blob": {"url": upload(npz(**{name: matrix.astype(STORED_DTYPE)}), NPZ), "content_type": NPZ},
                "data": {"sample_rate": SAMPLE_RATE, "hop_length": HOP_LENGTH, "shape": list(matrix.shape),
                         "timeseries": TIMESERIES[name]},
            })
    return out


def load(path: str) -> np.ndarray:
    """Decodes a file to mono at SAMPLE_RATE"""
    import librosa

    y, _ = librosa.load(path, sr=SAMPLE_RATE, mono=True)
    return y
