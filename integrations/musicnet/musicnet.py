"""
Ingests the MusicNet dataset (https://zenodo.org/records/5120004) into Cochlea.

    python integrations/musicnet/musicnet.py --data-dir ~/workspace/audio-data/musicnet

For each of the 330 pieces this registers a sound (pointing at the audio
mirror) and creates three kinds of annotations, all created by the API key's
user (a bot; see `yarn cli create-bot`):

- `musicnet-metadata@1` (kv, whole sound): the row from `musicnet_metadata.csv`
- `tags@1` (whole sound): composer, ensemble and the instruments that play
- `musicnet-note@1` (kv, one per note): the row from `{split}_labels/{id}.csv`,
  with the note's time span as the annotation's segment

It's idempotent. Sounds are unique by audio URL, and annotations are matched
by content (`cochlea_client.content_key`), so a second run creates nothing and
a run that died part-way through picks up where it left off.

Downloading the dataset isn't this script's job. `--data-dir` must hold:

    musicnet_metadata.csv
    {train,test}_labels/{id}.csv
    {train,test}_data/{id}.wav     (optional; read for exact durations)
"""

from __future__ import annotations

import argparse
import csv
import os
import struct
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from cochlea_client import CochleaClient, SyncResult

AUDIO_BASE_URL = "https://music-net.s3.us-east-1.amazonaws.com"
INFO_URL = "https://zenodo.org/records/5120004"
LICENSE = "https://creativecommons.org/licenses/by/4.0"
SAMPLE_RATE = 44100  # every MusicNet recording; used when the .wav isn't available
SPLITS = ("train", "test")

METADATA_SCHEMA = "musicnet-metadata@1"
NOTE_SCHEMA = "musicnet-note@1"
TAGS_SCHEMA = "tags@1"

SCHEMAS = {
    METADATA_SCHEMA: (
        "MusicNet piece metadata, from musicnet_metadata.csv: musicnet_id, composer, composition, "
        "movement, ensemble, source (the performer), transcriber, catalog_name, and split (train/test)."
    ),
    NOTE_SCHEMA: (
        "One MusicNet note label. The segment is the note's time span. kv holds the label row: "
        "start_time and end_time (in samples at 44.1kHz), instrument (General MIDI program, 1-based), "
        "instrument_name, note (MIDI pitch), start_beat, end_beat and note_value."
    ),
}

# MusicNet's instrument codes are 1-based General MIDI program numbers
INSTRUMENTS = {
    1: "Piano",
    7: "Harpsichord",
    41: "Violin",
    42: "Viola",
    43: "Cello",
    44: "Contrabass",
    61: "Horn",
    69: "Oboe",
    71: "Bassoon",
    72: "Clarinet",
    74: "Flute",
}


# ---------------------------------------------------------------------------
# Reading the dataset
# ---------------------------------------------------------------------------


@dataclass
class Piece:
    id: int
    split: str
    metadata: dict[str, str]
    labels_path: Path
    wav_path: Optional[Path]


def load_pieces(data_dir: Path) -> list[Piece]:
    metadata_path = data_dir / "musicnet_metadata.csv"
    if not metadata_path.exists():
        raise SystemExit(f"{metadata_path} not found; is --data-dir right?")
    pieces = []
    with open(metadata_path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            piece_id = int(row["id"])
            split = next((s for s in SPLITS if (data_dir / f"{s}_labels" / f"{piece_id}.csv").exists()), None)
            if split is None:
                raise SystemExit(f"no labels for piece {piece_id} in {data_dir}/{{train,test}}_labels")
            wav = data_dir / f"{split}_data" / f"{piece_id}.wav"
            pieces.append(
                Piece(
                    id=piece_id,
                    split=split,
                    metadata=row,
                    labels_path=data_dir / f"{split}_labels" / f"{piece_id}.csv",
                    wav_path=wav if wav.exists() else None,
                )
            )
    return sorted(pieces, key=lambda p: p.id)


def wav_frames(path: Path) -> tuple[int, int]:
    """(frames, sample rate) from a RIFF header. MusicNet's are float32, which the `wave` module can't read."""
    with open(path, "rb") as f:
        riff, _, wave = struct.unpack("<4sI4s", f.read(12))
        if riff != b"RIFF" or wave != b"WAVE":
            raise ValueError(f"{path} isn't a WAV file")
        block_align = sample_rate = None
        while header := f.read(8):
            chunk_id, size = struct.unpack("<4sI", header)
            if chunk_id == b"fmt ":
                _, _, sample_rate, _, block_align = struct.unpack("<HHIIH", f.read(14))
                f.seek(size - 14 + (size & 1), 1)
            elif chunk_id == b"data":
                if not block_align:
                    break
                return size // block_align, sample_rate
            else:
                f.seek(size + (size & 1), 1)
    raise ValueError(f"{path} has no fmt/data chunks")


def read_labels(path: Path) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as f:
        return [
            {
                "start_time": int(r["start_time"]),
                "end_time": int(r["end_time"]),
                "instrument": int(r["instrument"]),
                "note": int(r["note"]),
                "start_beat": float(r["start_beat"]),
                "end_beat": float(r["end_beat"]),
                "note_value": r["note_value"],
            }
            for r in csv.DictReader(f)
        ]


# ---------------------------------------------------------------------------
# Mapping to Cochlea
# ---------------------------------------------------------------------------


def duration_and_rate(piece: Piece, labels: list[dict]) -> tuple[float, int]:
    if piece.wav_path:
        frames, rate = wav_frames(piece.wav_path)
        return frames / rate, rate
    # without the audio, the best we have: the metadata (rounded to the second) or the last note
    last_note = max((label["end_time"] for label in labels), default=0) / SAMPLE_RATE
    return max(float(piece.metadata["seconds"]), last_note), SAMPLE_RATE


def sound_for(piece: Piece, duration_seconds: float, audio_base_url: str) -> dict:
    m = piece.metadata
    return {
        "audio_url": f"{audio_base_url.rstrip('/')}/{piece.id}",
        "license_type": LICENSE,
        "duration_seconds": duration_seconds,
        "title": f"{m['composer']}: {m['composition']}, {m['movement']}",
        "info_url": INFO_URL,
    }


def instrument_name(code: int) -> str:
    return INSTRUMENTS.get(code, f"GM program {code}")


def whole_sound_annotations(piece: Piece, labels: list[dict]) -> list[dict]:
    m = piece.metadata
    metadata = {
        "musicnet_id": piece.id,
        **{k: m[k] for k in ("composer", "composition", "movement", "ensemble", "source", "transcriber",
                             "catalog_name")},
        "split": piece.split,
    }
    instruments = sorted({label["instrument"] for label in labels})
    tags = [m["composer"], m["ensemble"], *(instrument_name(i) for i in instruments)]
    return [
        {"schema": METADATA_SCHEMA, "kv": metadata},
        {"schema": TAGS_SCHEMA, "tags": [t for t in tags if t.strip()]},
    ]


def note_annotations(labels: list[dict], sample_rate: int) -> list[dict]:
    return [
        {
            "schema": NOTE_SCHEMA,
            "start_seconds": label["start_time"] / sample_rate,
            "duration_seconds": (label["end_time"] - label["start_time"]) / sample_rate,
            "kv": {**label, "instrument_name": instrument_name(label["instrument"])},
        }
        for label in labels
    ]


def annotations_for(piece: Piece, labels: list[dict], sample_rate: int, notes: bool = True) -> list[dict]:
    return whole_sound_annotations(piece, labels) + (note_annotations(labels, sample_rate) if notes else [])


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data-dir", type=Path, default=os.environ.get("MUSICNET_DATA_DIR"),
                   help="local copy of the dataset (env MUSICNET_DATA_DIR)")
    p.add_argument("--api-url", default=os.environ.get("COCHLEA_API_URL", "http://localhost:8080/v1"),
                   help="env COCHLEA_API_URL; default %(default)s")
    p.add_argument("--api-key", default=os.environ.get("COCHLEA_API_KEY"),
                   help="a bot user's API key (env COCHLEA_API_KEY); see `yarn cli create-bot`")
    p.add_argument("--audio-base-url", default=AUDIO_BASE_URL,
                   help="where the audio is mirrored, as {base}/{id}; default %(default)s")
    p.add_argument("--ids", type=lambda s: {int(x) for x in s.split(",") if x},
                   help="only these MusicNet ids, e.g. 1727,1728")
    p.add_argument("--limit", type=int, help="only the first N pieces (by id)")
    p.add_argument("--no-notes", action="store_true", help="skip the note labels (metadata only)")
    p.add_argument("--access", choices=("public", "private"), default="public",
                   help="who can see new annotations; default %(default)s")
    p.add_argument("--dry-run", action="store_true", help="read and map everything, but don't call the API")
    args = p.parse_args(argv)
    if not args.data_dir:
        p.error("--data-dir (or MUSICNET_DATA_DIR) is required")
    if not args.dry_run and not args.api_key:
        p.error("--api-key (or COCHLEA_API_KEY) is required")
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    pieces = load_pieces(args.data_dir.expanduser())
    if args.ids:
        unknown = args.ids - {p.id for p in pieces}
        if unknown:
            raise SystemExit(f"not MusicNet ids: {', '.join(map(str, sorted(unknown)))}")
        pieces = [p for p in pieces if p.id in args.ids]
    if args.limit is not None:
        pieces = pieces[: args.limit]

    client = None if args.dry_run else CochleaClient(args.api_url, args.api_key)
    if client:
        me = client.me()
        print(f"ingesting {len(pieces)} pieces as {me['user_name']} (user {me['id']})", file=sys.stderr)
        for ref, description in SCHEMAS.items():
            client.ensure_schema(ref, "kv", description=description)

    access = "*" if args.access == "public" else None
    totals = SyncResult()
    started = time.monotonic()
    for n, piece in enumerate(pieces, 1):
        labels = read_labels(piece.labels_path)
        duration, rate = duration_and_rate(piece, labels)
        sound = sound_for(piece, duration, args.audio_base_url)
        annotations = annotations_for(piece, labels, rate, notes=not args.no_notes)
        prefix = f"[{n}/{len(pieces)}] {piece.id}"
        if not client:
            print(f"{prefix} {sound['title']}: {len(annotations)} annotations ({duration:.1f}s)", flush=True)
            continue

        created = client.create_sound(**sound)
        if created["created_by"] != me["id"]:
            print(f"{prefix} warning: sound {created['id']} was registered by user {created['created_by']}, "
                  "so it won't show up in this bot's sound feed", file=sys.stderr)
        if abs(created["duration_seconds"] - duration) > 0.01:
            print(f"{prefix} warning: sound {created['id']} has duration {created['duration_seconds']}s, "
                  f"but the audio is {duration}s", file=sys.stderr)
        result = client.sync_annotations(created["id"], annotations, access=access)
        totals += result
        print(f"{prefix} sound {created['id']}: {result.created} annotations created, "
              f"{result.existing} already there", flush=True)

    if client:
        elapsed = time.monotonic() - started
        print(f"done in {elapsed:.0f}s: {len(pieces)} sounds, {totals.created} annotations created, "
              f"{totals.existing} already there", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
