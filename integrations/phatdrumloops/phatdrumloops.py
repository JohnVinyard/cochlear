"""
Ingests the drum breaks from phatdrumloops.com (https://www.phatdrumloops.com/beats.php) into Cochlea.

    python integrations/phatdrumloops/phatdrumloops.py

The beats page lists 558 breaks; the 196 in its `/audio/wav/` directory are
mirrored at https://phat-drum-loops.s3.us-east-1.amazonaws.com (the ACM and
ADPCM ones aren't, and are skipped). For each mirrored break this registers a
sound and creates two annotations, both created by the API key's user (a bot;
see `yarn cli create-bot`):

- `phatdrumloops-metadata@1` (kv, whole sound): what the page says about it
  (title, artist, drummer, original album, compilations, upload date, and the
  prose description)
- `tags@1` (whole sound): `drums`

The page is hand-written HTML, so the scraping is best effort: entries are
split on the `<hr>` between them, and each field is read from its usual place
in the entry. A field that isn't there is left out.

It's idempotent. Sounds are unique by audio URL, and annotations are matched
by content (`cochlea_client.content_key`). The bot's annotations on each sound
are made to be exactly the ones above, so if the page (or this scraper)
changes, a re-run replaces the old metadata rather than adding to it.

Nothing is downloaded but the page, the mirror's bucket listing, and the
first 64 KB of each WAV (its header, for the exact duration and format).
"""

from __future__ import annotations

import argparse
import os
import re
import struct
import sys
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

from cochlea_client import CochleaClient, SyncResult

PAGE_URL = "https://www.phatdrumloops.com/beats.php"
AUDIO_BASE_URL = "https://phat-drum-loops.s3.us-east-1.amazonaws.com"
#: the mirrored directory: the page's /audio/wav/x.wav is {base}/audio/wav/x.wav
MIRRORED_PREFIX = "audio/wav/"
#: the mirror's MP3 of audio/wav/x.wav is low-quality/audio/wav/x.mp3
LOW_QUALITY_PREFIX = "low-quality/"

# These are excerpts of commercial recordings, and the site says it can't
# grant any rights to them
LICENSE = "all-rights-reserved"

METADATA_SCHEMA = "phatdrumloops-metadata@1"
TAGS_SCHEMA = "tags@1"
TAGS = ["drums"]

SCHEMAS = {
    METADATA_SCHEMA: (
        "A drum break's entry on phatdrumloops.com/beats.php, scraped from hand-written HTML (best effort; "
        "absent fields are omitted): file (its name on the site), title, artist, drummer, original_album, "
        "comps (compilations it appears on), uploaded (YYYY-MM-DD), and description (the site's prose, "
        "paragraphs separated by blank lines)."
    ),
}

HEADER_BYTES = 65536


# ---------------------------------------------------------------------------
# Scraping the page
# ---------------------------------------------------------------------------


@dataclass
class Entry:
    #: the link's path on the site, e.g. /audio/wav/8counts.wav
    href: str
    title: str
    artist: Optional[str] = None
    drummer: Optional[str] = None
    original_album: Optional[str] = None
    comps: Optional[str] = None
    uploaded: Optional[str] = None
    description: Optional[str] = None

    @property
    def key(self) -> str:
        """Where the mirror has it, if anywhere"""
        return self.href.lstrip("/")

    @property
    def file(self) -> str:
        return self.href.rsplit("/", 1)[-1]


ENTRY_SEPARATOR = re.compile(r"<hr\s+size=1\s+width=475\s*/?>", re.I)
PARAGRAPH = re.compile(r"<p\b[^>]*>|</p>", re.I)
LINE_BREAK = re.compile(r"<br\s*/?>", re.I)


def _clean(text: str) -> str:
    """Collapses whitespace (including &nbsp;) in one line of text"""
    return re.sub(r"\s+", " ", text.replace("\xa0", " ")).strip()


def _text(html: str) -> str:
    """Prose from a fragment of HTML: <p> separates paragraphs and <br> lines, other whitespace collapses"""
    paragraphs = []
    for chunk in PARAGRAPH.split(html):
        lines = [_clean(BeautifulSoup(line, "html.parser").get_text()) for line in LINE_BREAK.split(chunk)]
        paragraph = "\n".join(line for line in lines if line)
        if paragraph:
            paragraphs.append(paragraph)
    return "\n\n".join(paragraphs)


def _labelled(soup: BeautifulSoup, label: str) -> Optional[str]:
    """The text after `label:` in an element of its own (e.g. `<small>Drums: Elvin Jones</small>`)"""
    node = soup.find(string=re.compile(rf"^\s*{label}:", re.I))
    if node is None:
        return None
    value = _clean(re.sub(rf"^\s*{label}:", "", str(node), flags=re.I))
    return value or None


def parse_entry(html: str) -> Optional[Entry]:
    """One entry (the HTML between two <hr>s), or None if it doesn't link to a sample"""
    soup = BeautifulSoup(html, "html.parser")
    link = soup.find("a", href=re.compile(r"^/audio/"))
    if link is None:
        return None
    entry = Entry(href=link["href"], title=_clean(link.get_text()))

    by = soup.find(string=re.compile(r"\bBy:"))
    if by is not None:
        artist = by.find_next("b")
        entry.artist = _clean(artist.get_text()) if artist else None
    entry.drummer = _labelled(soup, "Drums")
    entry.uploaded = _labelled(soup, "Uploaded")

    # "Original Album: ...<br/>Comps: ...<br/>", in gray
    gray = soup.find("font", color=re.compile("gray", re.I))
    if gray is not None:
        for line in LINE_BREAK.split(gray.decode_contents()):
            name, sep, value = _clean(BeautifulSoup(line, "html.parser").get_text()).partition(":")
            if not sep or not value.strip():
                continue
            if name.lower() == "original album":
                entry.original_album = value.strip()
            elif name.lower() == "comps":
                entry.comps = value.strip()

    # The prose follows the gray block (or, without one, the header table), up to the next <hr>
    end = html.lower().rfind("</font>")
    if end < 0:
        end = html.lower().find("</table>")
    if end >= 0:
        entry.description = _text(html[end:].split(">", 1)[1]) or None
    return entry


def parse_page(html: str) -> list[Entry]:
    start, end = html.find("<!--START MAIN COLUMN-->"), html.find("<!--END MAIN COLUMN-->")
    if start >= 0 and end > start:
        html = html[start:end]
    entries = (parse_entry(chunk) for chunk in ENTRY_SEPARATOR.split(html))
    return [e for e in entries if e is not None]


def read_page(source: str) -> str:
    """The page's HTML, from a URL or a saved copy"""
    if urlparse(source).scheme in ("http", "https"):
        resp = requests.get(source, timeout=60)
        resp.raise_for_status()
        return resp.content.decode("utf-8", errors="replace")
    return Path(source).expanduser().read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# The mirror
# ---------------------------------------------------------------------------


def list_bucket(base_url: str) -> dict[str, int]:
    """Every key in the mirror's S3 bucket, with its size in bytes"""
    sizes: dict[str, int] = {}
    ns = {"s3": "http://s3.amazonaws.com/doc/2006-03-01/"}
    params = {"list-type": "2"}
    while True:
        resp = requests.get(base_url.rstrip("/") + "/", params=params, timeout=60)
        resp.raise_for_status()
        root = ET.fromstring(resp.content)
        for item in root.findall("s3:Contents", ns):
            sizes[item.findtext("s3:Key", namespaces=ns)] = int(item.findtext("s3:Size", namespaces=ns))
        token = root.findtext("s3:NextContinuationToken", namespaces=ns)
        if root.findtext("s3:IsTruncated", namespaces=ns) != "true" or not token:
            return sizes
        params["continuation-token"] = token


@dataclass(frozen=True)
class WavInfo:
    frames: int
    sample_rate: int
    channels: int
    bits_per_sample: int
    #: "int" (PCM) or "float" (IEEE float)
    sample_format: str

    @property
    def duration_seconds(self) -> float:
        return self.frames / self.sample_rate


WAVE_FORMAT_PCM, WAVE_FORMAT_IEEE_FLOAT, WAVE_FORMAT_EXTENSIBLE = 1, 3, 0xFFFE


def parse_wav_header(head: bytes, file_size: int) -> WavInfo:
    """
    What a RIFF/WAVE header says, from the start of the file. The data chunk's
    length is capped at what the file actually holds, since old editors
    sometimes wrote it wrong.
    """
    riff, _, wave = struct.unpack("<4sI4s", head[:12])
    if riff != b"RIFF" or wave != b"WAVE":
        raise ValueError("not a WAV file")
    pos, fmt = 12, None
    while pos + 8 <= len(head):
        chunk_id, size = struct.unpack("<4sI", head[pos:pos + 8])
        body = pos + 8
        if chunk_id == b"fmt ":
            tag, channels, rate, _, block_align, bits = struct.unpack("<HHIIHH", head[body:body + 16])
            if tag == WAVE_FORMAT_EXTENSIBLE and size >= 40:
                tag = struct.unpack("<H", head[body + 24:body + 26])[0]
            if tag not in (WAVE_FORMAT_PCM, WAVE_FORMAT_IEEE_FLOAT):
                raise ValueError(f"unsupported WAV format tag {tag}")
            fmt = (rate, channels, bits, block_align, "float" if tag == WAVE_FORMAT_IEEE_FLOAT else "int")
        elif chunk_id == b"data":
            if not fmt:
                break
            rate, channels, bits, block_align, sample_format = fmt
            data_bytes = min(size, file_size - body)
            return WavInfo(frames=data_bytes // block_align, sample_rate=rate, channels=channels,
                           bits_per_sample=bits, sample_format=sample_format)
        pos = body + size + (size & 1)
    raise ValueError(f"no fmt/data chunks in the first {len(head)} bytes")


def fetch_wav_info(url: str, file_size: int) -> WavInfo:
    resp = requests.get(url, headers={"Range": f"bytes=0-{HEADER_BYTES - 1}"}, timeout=60)
    resp.raise_for_status()
    return parse_wav_header(resp.content, file_size)


# ---------------------------------------------------------------------------
# Mapping to Cochlea
# ---------------------------------------------------------------------------


@dataclass
class Break:
    entry: Entry
    audio_url: str
    size_bytes: int
    #: the mirror's low-quality MP3, if it has one: (url, size in bytes)
    mp3: Optional[tuple[str, int]] = None
    wav: Optional[WavInfo] = field(default=None)


def mirrored(entries: list[Entry], bucket: dict[str, int], base_url: str) -> tuple[list[Break], list[Entry]]:
    """The entries the mirror has, and the ones it doesn't (each sample once: later duplicates are dropped)"""
    base = base_url.rstrip("/")
    breaks, missing, seen = [], [], set()
    for entry in entries:
        if entry.key not in bucket:
            missing.append(entry)
            continue
        if entry.key in seen:
            print(f"warning: {entry.href} is listed more than once; using its first entry", file=sys.stderr)
            continue
        seen.add(entry.key)
        mp3_key = LOW_QUALITY_PREFIX + re.sub(r"\.wav$", ".mp3", entry.key, flags=re.I)
        breaks.append(Break(
            entry=entry,
            audio_url=f"{base}/{entry.key}",
            size_bytes=bucket[entry.key],
            mp3=(f"{base}/{mp3_key}", bucket[mp3_key]) if mp3_key in bucket else None,
        ))
    return breaks, missing


def title_for(entry: Entry) -> str:
    return f"{entry.artist}: {entry.title}" if entry.artist else entry.title


def formats_for(b: Break) -> list[dict]:
    """The original WAV and the mirror's MP3, as the sound's formats (docs/sound-formats.md)"""
    formats = []
    if b.wav:
        formats.append({
            "url": b.audio_url,
            "mime_type": "audio/wav",
            "metadata": {
                "sample_rate": b.wav.sample_rate,
                "channels": b.wav.channels,
                "bit_depth": b.wav.bits_per_sample,
                "sample_format": b.wav.sample_format,
                "size_bytes": b.size_bytes,
            },
        })
    if b.mp3:
        url, size = b.mp3
        formats.append({"url": url, "mime_type": "audio/mpeg", "metadata": {"size_bytes": size}})
    return formats


def sound_for(b: Break, page_url: str) -> dict:
    assert b.wav, "the duration comes from the WAV header"
    return {
        "audio_url": b.audio_url,
        "license_type": LICENSE,
        "duration_seconds": b.wav.duration_seconds,
        "title": title_for(b.entry),
        "info_url": page_url,
        "formats": formats_for(b),
    }


def annotations_for(entry: Entry) -> list[dict]:
    fields = ("title", "artist", "drummer", "original_album", "comps", "uploaded", "description")
    metadata = {"file": entry.file, **{k: getattr(entry, k) for k in fields if getattr(entry, k)}}
    return [
        {"schema": METADATA_SCHEMA, "kv": metadata},
        {"schema": TAGS_SCHEMA, "tags": TAGS},
    ]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--page", default=PAGE_URL,
                   help="the beats page: a URL or a saved copy; default %(default)s")
    p.add_argument("--api-url", default=os.environ.get("COCHLEA_API_URL", "http://localhost:8080/v1"),
                   help="env COCHLEA_API_URL; default %(default)s")
    p.add_argument("--api-key", default=os.environ.get("COCHLEA_API_KEY"),
                   help="a bot user's API key (env COCHLEA_API_KEY); see `yarn cli create-bot`")
    p.add_argument("--audio-base-url", default=AUDIO_BASE_URL,
                   help="the mirror's S3 bucket; default %(default)s")
    p.add_argument("--files", type=lambda s: {x for x in s.split(",") if x},
                   help="only these samples, by file name, e.g. 8counts.wav,number1.wav")
    p.add_argument("--limit", type=int, help="only the first N mirrored breaks (in page order)")
    p.add_argument("--access", choices=("public", "private"), default="public",
                   help="who can see new annotations; default %(default)s")
    p.add_argument("--dry-run", action="store_true", help="scrape and map everything, but don't call the API")
    args = p.parse_args(argv)
    if not args.dry_run and not args.api_key:
        p.error("--api-key (or COCHLEA_API_KEY) is required")
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    entries = parse_page(read_page(args.page))
    breaks, missing = mirrored(entries, list_bucket(args.audio_base_url), args.audio_base_url)
    print(f"{len(entries)} entries on the page; {len(breaks)} mirrored, {len(missing)} not "
          f"({sum(1 for e in missing if not e.href.startswith('/' + MIRRORED_PREFIX))} of those aren't in "
          f"{MIRRORED_PREFIX})", file=sys.stderr)
    if args.files:
        unknown = args.files - {b.entry.file for b in breaks}
        if unknown:
            raise SystemExit(f"not mirrored: {', '.join(sorted(unknown))}")
        breaks = [b for b in breaks if b.entry.file in args.files]
    if args.limit is not None:
        breaks = breaks[: args.limit]

    client = None if args.dry_run else CochleaClient(args.api_url, args.api_key)
    if client:
        me = client.me()
        print(f"ingesting {len(breaks)} breaks as {me['user_name']} (user {me['id']})", file=sys.stderr)
        for ref, description in SCHEMAS.items():
            client.ensure_schema(ref, "kv", description=description)

    access = "*" if args.access == "public" else None
    totals = SyncResult()
    started, failed = time.monotonic(), 0
    for n, b in enumerate(breaks, 1):
        prefix = f"[{n}/{len(breaks)}] {b.entry.file}"
        try:
            b.wav = fetch_wav_info(b.audio_url, b.size_bytes)
        except (requests.RequestException, ValueError, struct.error) as e:
            print(f"{prefix} skipped: can't read the WAV header ({e})", file=sys.stderr)
            failed += 1
            continue
        sound = sound_for(b, args.page if urlparse(args.page).scheme else PAGE_URL)
        annotations = annotations_for(b.entry)
        if not client:
            kv = annotations[0]["kv"]
            print(f"{prefix} {sound['title']} ({sound['duration_seconds']:.2f}s, {b.wav.sample_rate} Hz): "
                  f"{', '.join(k for k in kv if k not in ('file', 'title'))}", flush=True)
            continue

        created = client.create_sound(**sound)
        if created["created_by"] != me["id"]:
            print(f"{prefix} warning: sound {created['id']} was registered by user {created['created_by']}, "
                  "so it won't show up in this bot's sound feed", file=sys.stderr)
        if created["license_type"] != LICENSE:
            print(f"{prefix} warning: sound {created['id']} has license {created['license_type']}, not {LICENSE}; "
                  "sounds are immutable, so a re-run won't change it", file=sys.stderr)
        result = client.sync_annotations(created["id"], annotations, access=access, prune=True)
        totals += result
        print(f"{prefix} sound {created['id']}: {result.created} annotations created, "
              f"{result.existing} already there, {result.deleted} replaced", flush=True)

    if client:
        elapsed = time.monotonic() - started
        print(f"done in {elapsed:.0f}s: {len(breaks) - failed} sounds, {totals.created} annotations created, "
              f"{totals.existing} already there, {totals.deleted} replaced", file=sys.stderr)
    if failed:
        print(f"{failed} skipped", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
