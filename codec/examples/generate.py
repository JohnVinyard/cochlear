"""
Generates the example documents in this directory. Deterministic, and
standard library only, so the output can be committed and diffed.

    python3 codec/examples/generate.py [--musicnet-dir ~/workspace/audio-data/musicnet]

The MusicNet example is only (re)generated when --musicnet-dir (or
MUSICNET_DATA_DIR) is given.
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import math
import os
import random
import struct
from pathlib import Path

HERE = Path(__file__).parent

KICK = "https://one-laptop-per-child.s3.amazonaws.com/tamtam44old/drum1kick.wav"
SNARE = "https://one-laptop-per-child.s3.amazonaws.com/tamtam44old/drum1snare.wav"
ROOM = "https://matching-pursuit-reverbs.s3.amazonaws.com/Nice+Drum+Room.wav"
CHURCH = "https://matching-pursuit-reverbs.s3.amazonaws.com/St+Nicolaes+Church.wav"

INSTRUMENTS = {1: "Piano", 7: "Harpsichord", 41: "Violin", 42: "Viola", 43: "Cello", 44: "Contrabass",
               61: "Horn", 69: "Oboe", 71: "Bassoon", 72: "Clarinet", 74: "Flute"}


GAMMATONE = "org.cochlea.gammatone"


def document(root: dict, *, requires: dict | None = None, defs: dict | None = None, **meta) -> dict:
    doc = {"$schema": "../schema/document.schema.json", "format": "cochlea-codec", "version": "0.2"}
    if requires:
        doc["requires"] = requires
    if meta:
        doc["meta"] = meta
    if defs:
        doc["defs"] = defs
    doc["root"] = root
    return doc


def ref(name: str, **overrides) -> dict:
    """A reference to a definition; label and meta may be overridden"""
    return {"$ref": f"#/defs/{name}", **overrides}


def wav_data_uri(samples: list[float], rate: int) -> str:
    data = b"".join(struct.pack("<h", round(max(-1.0, min(1.0, s)) * 32767)) for s in samples)
    header = (b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " +
              struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(data)))
    return "data:audio/wav;base64," + base64.b64encode(header + data).decode("ascii")


def hat() -> str:
    """A closed hi-hat: 60ms of decaying noise, at 22.05kHz (so decoders must resample it)"""
    rng = random.Random(1234)
    rate = 22050
    n = int(0.06 * rate)
    return wav_data_uri([rng.uniform(-1, 1) * math.exp(-i / (0.012 * rate)) * 0.8 for i in range(n)], rate)


def at(t: float, node: dict) -> dict:
    return {"time_seconds": round(t, 6), "node": node}


def drums() -> dict:
    """Fours all the way down, to show off <codec-viewer>'s max-depth: a song
    of 4 phrases, a phrase of 4 bars, a bar of 4 beats, a beat of a few hits"""
    beat = 0.5  # 120 bpm

    def fours(label: str, child: str, length: float, *items: str) -> dict:
        """Four things, one after another, labelled e.g. bar 1 to bar 4"""
        return {"type": "sequencer", "label": label,
                "events": [at(i * length, ref(x, label=f"{child} {i + 1}")) for i, x in enumerate(items)]}

    def hits(label: str, *sounds: tuple[float, str]) -> dict:
        return {"type": "sequencer", "label": label, "events": [at(t * beat, ref(x)) for t, x in sounds]}

    defs = {
        # depth 4: sounds, each defined once however often it plays
        "hat-sample": hat(),
        "hat-filter": {"type": "bandpass", "center_frequency": 9000, "bandwidth": 6000},
        "kick": {"type": "sampler", "label": "kick", "url": KICK, "gain": 0.9},
        "snare": {
            "type": "sampler", "label": "snare", "url": SNARE, "gain": 0.7,
            "envelope": {"type": "exponential", "points": [
                {"time_seconds": 0, "gain": 1}, {"time_seconds": 0.35, "gain": 0.001}]},
            "convolve": {"url": ROOM, "mix": 0.35},
        },
        "hat": {"type": "sampler", "label": "hat", "url": ref("hat-sample"), "gain": 0.5, "filter": ref("hat-filter")},
        "hat-soft": {"type": "sampler", "label": "hat (soft)", "url": ref("hat-sample"), "gain": 0.25,
                     "filter": ref("hat-filter")},
        # depth 3: one beat
        "downbeat": hits("beat: kick", (0, "kick"), (0, "hat"), (0.5, "hat-soft")),
        "backbeat": hits("beat: kick + snare", (0, "kick"), (0, "snare"), (0, "hat"), (0.5, "hat-soft")),
        "pickup": hits("beat: kick + snare, pickup", (0, "kick"), (0, "snare"), (0, "hat"), (0.5, "snare")),
        # depth 2: four beats make a bar
        "bar": fours("bar", "beat", beat, "downbeat", "backbeat", "downbeat", "backbeat"),
        "bar-pickup": fours("bar", "beat", beat, "downbeat", "backbeat", "downbeat", "pickup"),
        # the same bar at double speed takes half the time; twice makes a bar-long fill
        "fill": {"type": "sequencer", "label": "fill (double time)", "speed": 2, "events": [
            at(0, ref("bar", label="bar 1")), at(4 * beat, ref("bar-pickup", label="bar 2"))]},
        # depth 1: four bars make a phrase
        "phrase": fours("phrase", "bar", 4 * beat, "bar", "bar", "bar", "bar-pickup"),
        "phrase-fill": fours("phrase", "bar", 4 * beat, "bar", "bar", "bar", "fill"),
    }
    # depth 0: four phrases make the song
    return document(
        fours("song", "phrase", 16 * beat, "phrase", "phrase-fill", "phrase", "phrase-fill"),
        defs=defs,
        description="Fours all the way down: a song of 4 phrases, a phrase of 4 bars, a bar of 4 beats, a beat of "
                    "a few hits. Each sound and pattern is defined once, in defs, and used with $ref. Kick and snare "
                    "come from URLs, the hi-hat from a data: URI; envelope, band-pass and room reverb; the fills are "
                    "bars at double time, via a nested sequencer's speed. Try <codec-viewer>'s max-depth from 0 to 4.",
    )


def midi_hz(note: float) -> float:
    return 440.0 * 2 ** ((note - 69) / 12)


def gammatones() -> dict:
    chord = [60, 64, 67, 72]

    def arpeggio(label: str, speed: float, order: int) -> dict:
        return {"type": "sequencer", "label": label, "speed": speed, "events": [
            at(i * 0.25, {"type": GAMMATONE, "center_frequency": round(midi_hz(n), 3), "order": order,
                          "bandwidth": 12, "duration_seconds": 0.8, "gain": 0.4})
            for i, n in enumerate(chord + chord[::-1][1:])
        ]}

    return document(
        {"type": "sequencer", "label": "arpeggios", "events": [
            at(0, arpeggio("speed 1", 1, 4)),
            at(2, arpeggio("speed 1.5", 1.5, 4)),
            at(3.5, arpeggio("speed 2", 2, 2)),
            at(4.5, arpeggio("speed 3", 3, 6)),
            at(5.4, {"type": "sequencer", "label": "chord, in the church", "events": [
                at(0, {"type": GAMMATONE, "center_frequency": round(midi_hz(n), 3), "bandwidth": 3,
                       "duration_seconds": 3, "gain": 0.25}) for n in chord]}),
        ]},
        requires={GAMMATONE: "0.1"},
        description="The gammatone extension, in nested sequencers at different speeds",
    )


def musicnet(data_dir: Path, piece: int = 1727, seconds: float = 30) -> dict:
    split = next(s for s in ("train", "test") if (data_dir / f"{s}_labels" / f"{piece}.csv").exists())
    with open(data_dir / "musicnet_metadata.csv", newline="", encoding="utf-8") as f:
        meta = next(r for r in csv.DictReader(f) if int(r["id"]) == piece)
    by_instrument: dict[int, list[dict]] = {}
    with open(data_dir / f"{split}_labels" / f"{piece}.csv", newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            start, end = int(r["start_time"]) / 44100, int(r["end_time"]) / 44100
            if start >= seconds:
                continue
            duration = min(end - start, 3.0)
            by_instrument.setdefault(int(r["instrument"]), []).append(at(start, {
                "type": GAMMATONE,
                "center_frequency": round(midi_hz(int(r["note"])), 3),
                # narrower bands ring for longer, roughly matching the note
                "bandwidth": round(max(1.5, min(30.0, 1.2 / max(duration, 0.01))), 3),
                "duration_seconds": round(min(duration * 1.5 + 0.1, 4.0), 4),
                "gain": 0.08,
            }))
    return document(
        {"type": "sequencer", "label": f"{meta['composer']}: {meta['composition']}, {meta['movement']}",
         "events": [at(0, {"type": "sequencer", "label": INSTRUMENTS.get(code, f"program {code}"),
                           "events": sorted(events, key=lambda e: e["time_seconds"])})
                    for code, events in sorted(by_instrument.items())]},
        requires={GAMMATONE: "0.1"},
        description=f"The first {seconds:g}s of MusicNet {piece}'s note labels, played as gammatones, one sequencer "
                    "per instrument",
        source=f"https://music-net.s3.us-east-1.amazonaws.com/{piece}",
    )


def write(name: str, doc: dict) -> None:
    path = HERE / f"{name}.json"
    path.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {path} ({path.stat().st_size // 1024} KB)")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--musicnet-dir", type=Path, default=os.environ.get("MUSICNET_DATA_DIR"))
    args = p.parse_args()
    write("drums", drums())
    write("gammatones", gammatones())
    if args.musicnet_dir:
        write("musicnet-1727-gammatones", musicnet(args.musicnet_dir.expanduser()))


if __name__ == "__main__":
    main()
