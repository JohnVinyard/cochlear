"""
Renders cochlea codec documents (`.sprs`, `audio/vnd.cochlea.sprs+json`; see
codec/SPEC.md) to audio, with the same WebAssembly decoder the web app uses
(codec/rust/crates/wasm), run by wasmtime. Python is the host: it does the
I/O the decoder asks for.

    from cochlea_client.codec import render
    samples = render(document, sample_rate=22050, base_url=url)   # mono float32

The decoder says which parts of each resource it needs (a sampler only
needs its slice), and `AudioLoader` loads just those, where it can:

- local files (paths, `file://` URLs, or what `local_path` maps a URL to)
  are read partially, with soundfile;
- WAV files over HTTP: the header once, then only the bytes of each span,
  with Range requests;
- anything else is downloaded whole and decoded with soundfile.

The decoder is `web/public/codec/cochlea_codec.wasm` in this repository
(`yarn build-codec`), or wherever `COCHLEA_CODEC_WASM` says. Needs the
`codec` extra: numpy, soundfile, wasmtime.
"""
from __future__ import annotations

import base64
import io
import json
import os
import struct
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional, Union

import numpy as np
import requests

SPRS_MIME_TYPE = "audio/vnd.cochlea.sprs+json"

#: Where the decoder is built to, relative to this repository's root
REPO_WASM = Path("web/public/codec/cochlea_codec.wasm")

HEADER_BYTES = 64 * 1024
#: Spans closer than this are fetched in one request
MERGE_GAP_SECONDS = 2.0


class CodecError(Exception):
    """The decoder rejected the document, or couldn't render it"""

    def __init__(self, path: str, message: str):
        super().__init__(f"{path}: {message}" if path else message)
        self.path, self.message = path, message


class ResourceError(Exception):
    """A resource couldn't be loaded. `transient` errors may work if retried."""

    def __init__(self, message: str, transient: bool = False):
        super().__init__(message)
        self.transient = transient


@dataclass
class Span:
    start_seconds: float
    #: None: to the end
    end_seconds: Optional[float]


@dataclass
class Piece:
    """Mono audio for part (or all) of a resource"""
    offset_seconds: float
    samples: np.ndarray  # float32
    sample_rate: float
    #: The whole resource's length, if known
    total_seconds: Optional[float]

    @property
    def end_seconds(self) -> float:
        return self.offset_seconds + len(self.samples) / self.sample_rate

    def covers(self, span: Span) -> bool:
        slop = 1 / self.sample_rate
        end = span.end_seconds if span.end_seconds is not None else self.total_seconds
        if end is None:
            return False
        start = span.start_seconds
        if self.total_seconds is not None:
            end, start = min(end, self.total_seconds), min(start, self.total_seconds)
        return self.offset_seconds <= start + slop and end <= self.end_seconds + slop


def is_codec_sound(sound: dict) -> bool:
    """Whether a sound's audio is a codec document: a format at its audio_url says so"""
    return any(f.get("mime_type") == SPRS_MIME_TYPE and f.get("url") == sound.get("audio_url")
               for f in sound.get("formats") or [])


def parse_document(data: Union[bytes, str]) -> Optional[dict]:
    """The codec document in `data`, or None if it isn't one"""
    try:
        doc = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        return None
    return doc if isinstance(doc, dict) and doc.get("format") == "cochlea-codec" else None


def merge_spans(spans: list[Span], gap: float = MERGE_GAP_SECONDS) -> list[Span]:
    out: list[Span] = []
    for s in sorted(spans, key=lambda s: s.start_seconds):
        last = out[-1] if out else None
        if last and (last.end_seconds is None or s.start_seconds <= last.end_seconds + gap):
            last.end_seconds = None if last.end_seconds is None or s.end_seconds is None \
                else max(last.end_seconds, s.end_seconds)
        else:
            out.append(Span(s.start_seconds, s.end_seconds))
    return out


def find_wasm() -> Path:
    env = os.environ.get("COCHLEA_CODEC_WASM")
    if env:
        return Path(env)
    # clients/python/cochlea_client/codec.py -> the repository root
    return Path(__file__).resolve().parents[3] / REPO_WASM


# ---------------------------------------------------------------------------
# the decoder (codec/rust/crates/wasm: a plain C ABI over linear memory)
# ---------------------------------------------------------------------------

class _Module:
    _cache: dict[Path, Any] = {}

    @classmethod
    def load(cls, path: Path):
        import wasmtime

        key = path.resolve()
        if key not in cls._cache:
            if not path.is_file():
                raise FileNotFoundError(f"no codec decoder at {path}: build it with `yarn build-codec` "
                                        "(or set COCHLEA_CODEC_WASM)")
            engine = wasmtime.Engine()
            cls._cache[key] = (engine, wasmtime.Module.from_file(engine, str(path)))
        return cls._cache[key]


class Decoder:
    """One decoder instance: load a document, provide its resources, build, render"""

    def __init__(self, sample_rate: float, wasm: Optional[Path] = None):
        import wasmtime

        engine, module = _Module.load(wasm or find_wasm())
        self._store = wasmtime.Store(engine)
        instance = wasmtime.Instance(self._store, module, [])
        self._x = instance.exports(self._store)
        self._memory = self._x["memory"]
        self._h = self._call("cc_new", float(sample_rate))
        self.sample_rate = sample_rate

    def _call(self, name: str, *args):
        return self._x[name](self._store, *args)

    def _alloc(self, data: bytes) -> int:
        ptr = self._call("cc_alloc", len(data))
        if data:
            self._memory.write(self._store, data, ptr)
        return ptr

    def _result(self, status: int) -> Any:
        ptr, n = self._call("cc_result_ptr", self._h), self._call("cc_result_len", self._h)
        value = json.loads(bytes(self._memory.read(self._store, ptr, ptr + n)))
        if status != 0:
            raise CodecError(value.get("path", ""), value.get("message", "decoder error"))
        return value

    def _with(self, data: bytes, f: Callable[[int, int], int]) -> int:
        ptr = self._alloc(data)
        try:
            return f(ptr, len(data))
        finally:
            self._call("cc_free", ptr, len(data))

    def load(self, document: Union[dict, str, bytes]) -> dict:
        data = document if isinstance(document, bytes) else \
            (document if isinstance(document, str) else json.dumps(document)).encode()
        return self._result(self._with(data, lambda p, n: self._call("cc_load", self._h, p, n)))

    def resource_requests(self) -> list[tuple[str, list[Span]]]:
        requests_ = self._result(self._call("cc_resource_requests", self._h))
        return [(r["uri"], [Span(s["start_seconds"], s["end_seconds"]) for s in r["spans"]]) for r in requests_]

    def provide(self, uri: str, piece: Piece) -> None:
        pcm = np.ascontiguousarray(piece.samples, dtype="<f4").tobytes()
        total = -1.0 if piece.total_seconds is None else float(piece.total_seconds)

        def call(up: int, un: int) -> int:
            return self._with(pcm, lambda pp, _: self._call(
                "cc_provide_span", self._h, up, un, pp, len(piece.samples),
                float(piece.sample_rate), float(piece.offset_seconds), total))

        self._result(self._with(uri.encode(), call))

    def build(self, path: str = "") -> dict:
        """Prepares the whole document (or one node, by JSON Pointer); describes where every node plays"""
        return self._result(self._with(path.encode(), lambda p, n: self._call("cc_build", self._h, p, n)))

    def render_all(self, block_seconds: float = 10) -> np.ndarray:
        frames = max(1, int(self.sample_rate * block_seconds))
        out_ptr = self._call("cc_alloc", frames * 4)
        chunks = []
        try:
            while True:
                n = self._call("cc_render", self._h, out_ptr, frames)
                chunks.append(np.frombuffer(bytes(self._memory.read(self._store, out_ptr, out_ptr + n * 4)), "<f4"))
                if n < frames:
                    break
        finally:
            self._call("cc_free", out_ptr, frames * 4)
        return np.concatenate(chunks).astype(np.float32) if chunks else np.zeros(0, np.float32)

    def close(self) -> None:
        if self._h:
            self._call("cc_destroy", self._h)
            self._h = 0

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


# ---------------------------------------------------------------------------
# loading resources
# ---------------------------------------------------------------------------

@dataclass
class _Wav:
    format: int  # 1: integer PCM, 3: float
    channels: int
    sample_rate: int
    bits: int
    block_align: int
    data_offset: int
    data_bytes: int

    @property
    def total_seconds(self) -> float:
        return self.data_bytes / self.block_align / self.sample_rate


def _parse_wav_header(head: bytes) -> Optional[_Wav]:
    if len(head) < 12 or head[0:4] != b"RIFF" or head[8:12] != b"WAVE":
        return None
    at, fmt = 12, None
    while at + 8 <= len(head):
        cid, size = head[at:at + 4], struct.unpack_from("<I", head, at + 4)[0]
        if cid == b"fmt ":
            tag, channels, rate, _, align, bits = struct.unpack_from("<HHIIHH", head, at + 8)
            if tag == 0xFFFE and size >= 40:  # WAVE_FORMAT_EXTENSIBLE
                tag = struct.unpack_from("<H", head, at + 32)[0]
            if tag not in (1, 3):
                return None
            fmt = (tag, channels, rate, bits, align)
        elif cid == b"data":
            return _Wav(*fmt, at + 8, size) if fmt else None
        at += 8 + size + (size % 2)
    return None


def _decode_pcm(data: bytes, w: _Wav) -> np.ndarray:
    """Interleaved PCM to mono float32"""
    frames = len(data) // w.block_align
    raw = np.frombuffer(data[:frames * w.block_align], np.uint8).reshape(frames, w.channels, w.bits // 8)
    if w.format == 3:
        x = raw.copy().view("<f4" if w.bits == 32 else "<f8")[..., 0]
    elif w.bits == 8:
        x = (raw[..., 0].astype(np.float32) - 128) / 128
    elif w.bits == 24:
        b = raw.astype(np.int32)
        x = ((b[..., 0] | (b[..., 1] << 8) | (b[..., 2] << 16)) << 8 >> 8) / 8388608
    else:
        dtype = {16: "<i2", 32: "<i4"}[w.bits]
        x = raw.copy().view(dtype)[..., 0] / float(2 ** (w.bits - 1))
    return x.mean(axis=1).astype(np.float32)


def _mono(x: np.ndarray) -> np.ndarray:
    return (x.mean(axis=1) if x.ndim == 2 else x).astype(np.float32)


class AudioLoader:
    """
    Loads the spans of resources a document needs. Keeps what it loads, so
    one loader can serve many documents. `local_path(url)` may map a URL to
    a local file (e.g. a mirror); return None to fetch it.
    """

    def __init__(self, local_path: Optional[Callable[[str], Optional[Path]]] = None,
                 session: Optional[requests.Session] = None, timeout: float = 60, max_bytes: int = 4 << 30):
        self.local_path = local_path or (lambda _: None)
        self.session = session or requests.Session()
        self.timeout = timeout
        self.max_bytes = max_bytes
        self.pieces: dict[str, list[Piece]] = {}
        self._wav: dict[str, Optional[_Wav]] = {}
        #: (url, Range or None) of every HTTP request made, for the curious (and tests)
        self.fetches: list[tuple[str, Optional[str]]] = []

    def load(self, uri: str, spans: list[Span], base_url: Optional[str] = None) -> list[Piece]:
        have = self.pieces.setdefault(uri, [])
        needed = [s for s in spans if not any(p.covers(s) for p in have)]
        if needed:
            url = urllib.parse.urljoin(base_url, uri) if base_url else uri
            have.extend(self._load(url, merge_spans(needed)))
        used: list[Piece] = []
        for s in spans:
            piece = next((p for p in have if p.covers(s)), None)
            if piece is not None and all(piece is not u for u in used):
                used.append(piece)
        return used

    def _load(self, url: str, spans: list[Span]) -> list[Piece]:
        if url.startswith("data:"):
            return [self._decode_whole(self._data_uri(url))]
        path = self._file_path(url)
        if path is not None:
            return [self._read_file(path, s) for s in spans]
        wav = self._probe(url)
        if wav is None:
            return [self._decode_whole(self._download(url))]
        return [self._fetch_span(url, wav, s) for s in spans]

    # -- local files --------------------------------------------------------

    def _file_path(self, url: str) -> Optional[Path]:
        mapped = self.local_path(url)
        if mapped is not None and Path(mapped).is_file():
            return Path(mapped)
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme == "file":
            return Path(urllib.parse.unquote(parsed.path))
        if parsed.scheme == "" and url:
            return Path(url)
        return None

    def _read_file(self, path: Path, span: Span) -> Piece:
        import soundfile

        try:
            with soundfile.SoundFile(str(path)) as f:
                total = f.frames / f.samplerate
                start = min(int(span.start_seconds * f.samplerate), f.frames)
                end = f.frames if span.end_seconds is None else min(int(np.ceil(span.end_seconds * f.samplerate)), f.frames)
                f.seek(start)
                x = f.read(max(0, end - start), dtype="float32", always_2d=True)
                return Piece(start / f.samplerate, _mono(x), f.samplerate, total)
        except (RuntimeError, OSError) as e:  # soundfile raises LibsndfileError (a RuntimeError)
            raise ResourceError(f"couldn't read {path}: {e}") from e

    # -- HTTP -----------------------------------------------------------------

    def _get(self, url: str, range_: Optional[str] = None) -> requests.Response:
        self.fetches.append((url, range_))
        try:
            resp = self.session.get(url, headers={"Range": range_} if range_ else {}, timeout=self.timeout, stream=True)
        except requests.exceptions.InvalidURL as e:
            raise ResourceError(f"invalid URL {url}: {e}") from e
        except requests.exceptions.RequestException as e:
            raise ResourceError(f"fetching {url}: {e}", transient=True) from e
        if resp.status_code == 429 or resp.status_code >= 500:
            resp.close()
            raise ResourceError(f"HTTP {resp.status_code} fetching {url}", transient=True)
        if not resp.ok:
            resp.close()
            raise ResourceError(f"HTTP {resp.status_code} fetching {url}")
        return resp

    def _probe(self, url: str) -> Optional[_Wav]:
        """The WAV header at `url`, if it's a WAV file and the server honours Range"""
        if url not in self._wav:
            resp = self._get(url, f"bytes=0-{HEADER_BYTES - 1}")
            with resp:
                if resp.status_code != 206:
                    self._wav[url] = None
                else:
                    wav = _parse_wav_header(resp.content)
                    size = resp.headers.get("Content-Range", "").rpartition("/")[2]
                    # streamed WAVs may say 0 (or 0xFFFFFFFF) bytes of data: trust the file size
                    if wav and size.isdigit() and (wav.data_bytes == 0 or wav.data_offset + wav.data_bytes > int(size)):
                        wav.data_bytes = int(size) - wav.data_offset
                    self._wav[url] = wav
        return self._wav[url]

    def _fetch_span(self, url: str, wav: _Wav, span: Span) -> Piece:
        frames = wav.data_bytes // wav.block_align
        first = min(int(span.start_seconds * wav.sample_rate), frames)
        last = frames if span.end_seconds is None else min(int(np.ceil(span.end_seconds * wav.sample_rate)), frames)
        if last <= first:  # past the end: the decoder says so, knowing the length
            return Piece(first / wav.sample_rate, np.zeros(0, np.float32), wav.sample_rate, wav.total_seconds)
        start = wav.data_offset + first * wav.block_align
        end = wav.data_offset + last * wav.block_align - 1
        with self._get(url, f"bytes={start}-{end}") as resp:
            if resp.status_code != 206:  # the server ignores ranges after all
                self._wav[url] = None
                return self._decode_whole(self._read_capped(resp, url))
            data = resp.content
        return Piece(first / wav.sample_rate, _decode_pcm(data, wav), wav.sample_rate, wav.total_seconds)

    def _read_capped(self, resp: requests.Response, url: str) -> bytes:
        if int(resp.headers.get("Content-Length") or 0) > self.max_bytes:
            raise ResourceError(f"{url} is larger than {self.max_bytes} bytes")
        buf = io.BytesIO()
        for chunk in resp.iter_content(1 << 20):
            buf.write(chunk)
            if buf.tell() > self.max_bytes:
                raise ResourceError(f"{url} is larger than {self.max_bytes} bytes")
        return buf.getvalue()

    def _download(self, url: str) -> bytes:
        with self._get(url) as resp:
            return self._read_capped(resp, url)

    # -- whole files ----------------------------------------------------------

    @staticmethod
    def _data_uri(uri: str) -> bytes:
        header, _, payload = uri.partition(",")
        return base64.b64decode(payload) if header.endswith(";base64") else urllib.parse.unquote_to_bytes(payload)

    @staticmethod
    def _decode_whole(data: bytes) -> Piece:
        import soundfile

        try:
            x, rate = soundfile.read(io.BytesIO(data), dtype="float32", always_2d=True)
        except (RuntimeError, OSError) as e:
            raise ResourceError(f"couldn't decode the audio: {e}") from e
        return Piece(0.0, _mono(x), rate, len(x) / rate)


# ---------------------------------------------------------------------------

def render(document: Union[dict, str, bytes], sample_rate: float = 44100, base_url: Optional[str] = None,
           loader: Optional[AudioLoader] = None, wasm: Optional[Path] = None) -> np.ndarray:
    """
    Renders a whole codec document to mono float32 samples at `sample_rate`.
    `base_url` resolves relative URIs in it (usually the document's own URL).
    Raises CodecError for a document the decoder rejects, ResourceError for
    audio it can't load.
    """
    loader = loader or AudioLoader()
    with Decoder(sample_rate, wasm) as d:
        d.load(document)
        for uri, spans in d.resource_requests():
            for piece in loader.load(uri, spans, base_url):
                d.provide(uri, piece)
        missing = d.resource_requests()
        if missing:
            raise ResourceError(f"couldn't load all of: {', '.join(uri for uri, _ in missing)}")
        d.build()
        return d.render_all()
