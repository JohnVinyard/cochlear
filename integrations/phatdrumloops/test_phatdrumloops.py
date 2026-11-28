import struct

import pytest

import phatdrumloops as p

# Three entries as the page writes them: a mirrored one with everything, a
# mirrored one with little, and an ACM one the mirror doesn't have
PAGE = """
<!--START MAIN COLUMN-->
<h2>3 entries</h2>Sorted by <b>Artist</b><br/>
		<br/><br/><hr size=1 width=475><br/>
		<table width=100% cellpadding=0 cellspacing=0 border=0><td align=left valign=top>
		<a href="/audio/wav/snakefoot.wav" target="_top"><b>FUNKY SNAKEFOOT [PART 1 OF 2]</b></a><br/>
		By: <b>Alphonse Mouzon</b>
		<br/><small>Drums: Elvin Jones</small>		</td>
		<td align=right valign=top>
				<small>File Format: Lo-Res&nbsp;PCM&nbsp;WAV&nbsp;-&nbsp;worst</small><br/>
		<small>Uploaded: 1999-04-26</small>
				</td></table>
		<p>
		<font color="gray"><small>
		&nbsp;&nbsp;&nbsp;&nbsp;Original Album: Funky Snakefoot ('73)<br/>&nbsp;&nbsp;&nbsp;&nbsp;Comps: Electric Blue (Blue Note UK)<br/>		</small></font>
		<p>
		Drummer is   Elvin Jones.
<p>
Submitted by <A HREF=mailto:someone@example.com>Jammy</a>.<br>Second line &amp; more…
		<br/><br/><hr size=1 width=475><br/>
		<table width=100% cellpadding=0 cellspacing=0 border=0><td align=left valign=top>
		<a href="/audio/wav/8counts.wav" target="_top"><b>EIGHT COUNTS FOR RITA</b></a><br/>
		By: <b>Jimmy Smith</b>
				</td>
		<td align=right valign=top>
		<small>Uploaded: 1998-11-04</small>
				</td></table>
		<p>
		<font color="gray"><small>
				</small></font>
		<p>
		Bass, snare, bass, snare.
		<br/><br/><hr size=1 width=475><br/>
		<table width=100% cellpadding=0 cellspacing=0 border=0><td align=left valign=top>
		<a href="/audio/acm/speed_kills.wav" target="_top"><b>SPEED KILLS</b></a><br/>
		By: <b>10cc</b>
				</td></table>
		<p>Weirdo beat.
			</td></table>
<!--END MAIN COLUMN-->
<font color="gray"><small>All original content &copy;1996+</small></font>
"""

BASE = "https://mirror.example"
BUCKET = {"audio/wav/snakefoot.wav": 5000, "audio/wav/8counts.wav": 93148,
          "low-quality/audio/wav/8counts.mp3": 9000}


def test_scrapes_every_entry_and_its_fields():
    snakefoot, counts, speed = p.parse_page(PAGE)
    assert snakefoot == p.Entry(
        href="/audio/wav/snakefoot.wav",
        title="FUNKY SNAKEFOOT [PART 1 OF 2]",
        artist="Alphonse Mouzon",
        drummer="Elvin Jones",
        original_album="Funky Snakefoot ('73)",
        comps="Electric Blue (Blue Note UK)",
        uploaded="1999-04-26",
        description="Drummer is Elvin Jones.\n\nSubmitted by Jammy.\nSecond line & more…",
    )
    assert counts == p.Entry(href="/audio/wav/8counts.wav", title="EIGHT COUNTS FOR RITA", artist="Jimmy Smith",
                             uploaded="1998-11-04", description="Bass, snare, bass, snare.")
    # no gray block: the prose follows the header table
    assert (speed.artist, speed.description) == ("10cc", "Weirdo beat.")


def test_keeps_only_what_the_mirror_has():
    breaks, missing = p.mirrored(p.parse_page(PAGE), BUCKET, BASE + "/")
    assert [b.audio_url for b in breaks] == [f"{BASE}/audio/wav/snakefoot.wav", f"{BASE}/audio/wav/8counts.wav"]
    assert [e.href for e in missing] == ["/audio/acm/speed_kills.wav"]
    assert breaks[0].mp3 is None
    assert breaks[1].mp3 == (f"{BASE}/low-quality/audio/wav/8counts.mp3", 9000)


def wav_header(frames: int, rate=11025, channels=1, bits=16, declared_frames=None) -> bytes:
    block = channels * bits // 8
    fmt = struct.pack("<HHIIHH", 1, channels, rate, rate * block, block, bits)
    data = (declared_frames if declared_frames is not None else frames) * block
    return (struct.pack("<4sI4s", b"RIFF", 36 + data, b"WAVE") + struct.pack("<4sI", b"fmt ", len(fmt)) + fmt
            + struct.pack("<4sI", b"LIST", 5) + b"INFO!\0"  # an odd-sized chunk to skip, with its pad byte
            + struct.pack("<4sI", b"data", data))


def test_reads_the_wav_header():
    head = wav_header(frames=11025 * 2)
    info = p.parse_wav_header(head, file_size=len(head) + 11025 * 2 * 2)
    assert info == p.WavInfo(frames=22050, sample_rate=11025, channels=1, bits_per_sample=16, sample_format="int")
    assert info.duration_seconds == 2.0


def test_trusts_the_file_size_over_a_wrong_data_length():
    head = wav_header(frames=100, declared_frames=1_000_000)
    assert p.parse_wav_header(head, file_size=len(head) + 200).frames == 100


def test_rejects_what_isnt_a_wav():
    with pytest.raises(ValueError):
        p.parse_wav_header(b"ID3\x03" + b"\0" * 60, file_size=64)


def test_maps_a_break_to_a_sound_and_annotations():
    _, counts = p.mirrored(p.parse_page(PAGE), BUCKET, BASE)[0]
    counts.wav = p.WavInfo(frames=11025 * 4, sample_rate=11025, channels=1, bits_per_sample=16, sample_format="int")
    sound = p.sound_for(counts, p.PAGE_URL)
    assert sound["title"] == "Jimmy Smith: EIGHT COUNTS FOR RITA"
    assert sound["duration_seconds"] == 4.0
    assert sound["info_url"] == p.PAGE_URL
    assert sound["formats"] == [
        {"url": f"{BASE}/audio/wav/8counts.wav", "mime_type": "audio/wav",
         "metadata": {"sample_rate": 11025, "channels": 1, "bit_depth": 16, "sample_format": "int",
                      "size_bytes": 93148}},
        {"url": f"{BASE}/low-quality/audio/wav/8counts.mp3", "mime_type": "audio/mpeg",
         "metadata": {"size_bytes": 9000}},
    ]
    metadata, tags = p.annotations_for(counts.entry)
    # absent fields are left out rather than null
    assert metadata == {"schema": "phatdrumloops-metadata@1", "kv": {
        "file": "8counts.wav", "title": "EIGHT COUNTS FOR RITA", "artist": "Jimmy Smith",
        "uploaded": "1998-11-04", "description": "Bass, snare, bass, snare."}}
    assert tags == {"schema": "tags@1", "tags": ["drums"]}
