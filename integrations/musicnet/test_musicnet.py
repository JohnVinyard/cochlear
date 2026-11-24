import struct
from pathlib import Path

import pytest

import musicnet

METADATA = (
    '"id","composer","composition","movement","ensemble","source","transcriber","catalog_name","seconds"\n'
    '1730,"Schubert","Piano Quintet in A major","5. Allegro giusto","Piano Quintet","European Archive",'
    '"http://tirolmusic.blogspot.com/","OP114",368\n'
)
LABELS = (
    "start_time,end_time,instrument,note,start_beat,end_beat,note_value\n"
    "9182,90078,43,53,4.0,1.5,Dotted Quarter\n"
    "44100,88200,1,69,4.0,1.0,Quarter\n"
)


def write_wav(path: Path, frames: int, rate: int = 44100) -> None:
    fmt = struct.pack("<HHIIHH", 3, 1, rate, rate * 4, 4, 32)
    data_size = frames * 4
    with open(path, "wb") as f:
        f.write(struct.pack("<4sI4s", b"RIFF", 4 + 8 + len(fmt) + 8 + data_size, b"WAVE"))
        f.write(struct.pack("<4sI", b"fmt ", len(fmt)) + fmt)
        f.write(struct.pack("<4sI", b"LIST", 4) + b"INFO")  # a chunk to skip
        f.write(struct.pack("<4sI", b"data", data_size))
        f.write(b"\0" * data_size)


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    (tmp_path / "musicnet_metadata.csv").write_text(METADATA)
    (tmp_path / "test_labels").mkdir()
    (tmp_path / "test_labels" / "1730.csv").write_text(LABELS)
    return tmp_path


def test_loads_pieces_and_finds_their_split(data_dir: Path):
    [piece] = musicnet.load_pieces(data_dir)
    assert (piece.id, piece.split, piece.wav_path) == (1730, "test", None)


def test_exact_duration_from_the_wav_header(data_dir: Path):
    (data_dir / "test_data").mkdir()
    write_wav(data_dir / "test_data" / "1730.wav", frames=44100 * 3 + 50)
    [piece] = musicnet.load_pieces(data_dir)
    duration, rate = musicnet.duration_and_rate(piece, musicnet.read_labels(piece.labels_path))
    assert (duration, rate) == ((44100 * 3 + 50) / 44100, 44100)


def test_falls_back_to_metadata_duration_without_audio(data_dir: Path):
    [piece] = musicnet.load_pieces(data_dir)
    assert musicnet.duration_and_rate(piece, musicnet.read_labels(piece.labels_path)) == (368.0, 44100)


def test_maps_a_piece_to_a_sound_and_annotations(data_dir: Path):
    [piece] = musicnet.load_pieces(data_dir)
    labels = musicnet.read_labels(piece.labels_path)
    sound = musicnet.sound_for(piece, 368.0, "https://mirror.example/")
    assert sound["audio_url"] == "https://mirror.example/1730"
    assert sound["title"] == "Schubert: Piano Quintet in A major, 5. Allegro giusto"

    metadata, tags, *notes = musicnet.annotations_for(piece, labels, 44100)
    assert metadata["schema"] == "musicnet-metadata@1"
    assert metadata["kv"]["musicnet_id"] == 1730 and metadata["kv"]["split"] == "test"
    assert "seconds" not in metadata["kv"]
    assert tags == {"schema": "tags@1", "tags": ["Schubert", "Piano Quintet", "Piano", "Cello"]}
    assert notes[1] == {
        "schema": "musicnet-note@1",
        "start_seconds": 1.0,
        "duration_seconds": 1.0,
        "kv": {"start_time": 44100, "end_time": 88200, "instrument": 1, "note": 69, "start_beat": 4.0,
               "end_beat": 1.0, "note_value": "Quarter", "instrument_name": "Piano"},
    }
    assert "start_seconds" not in metadata  # whole-sound annotations have no segment


def test_no_notes(data_dir: Path):
    [piece] = musicnet.load_pieces(data_dir)
    annotations = musicnet.annotations_for(piece, musicnet.read_labels(piece.labels_path), 44100, notes=False)
    assert [a["schema"] for a in annotations] == ["musicnet-metadata@1", "tags@1"]
