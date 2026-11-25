"""
The codec host, against the real WebAssembly decoder (skipped if it hasn't
been built: `yarn build-codec`).
"""
import base64
import http.server
import io
import threading

import numpy as np
import pytest
import soundfile

from cochlea_client import codec
from cochlea_client.codec import AudioLoader, Span, find_wasm, is_codec_sound, merge_spans, parse_document, render

needs_decoder = pytest.mark.skipif(not find_wasm().is_file(), reason="the codec decoder isn't built (yarn build-codec)")

RATE = 8000


def tone(seconds: float, channels: int = 1) -> np.ndarray:
    t = np.arange(int(seconds * RATE)) / RATE
    x = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
    return np.stack([x] * channels, axis=1) if channels > 1 else x


def wav_bytes(x: np.ndarray, subtype: str = "PCM_16") -> bytes:
    buf = io.BytesIO()
    soundfile.write(buf, x, RATE, format="WAV", subtype=subtype)
    return buf.getvalue()


def doc(*events) -> dict:
    return {"format": "cochlea-codec", "version": "0.2",
            "root": {"type": "sequencer", "events": [{"time_seconds": t, "node": n} for t, n in events]}}


def sampler(url: str, start: float, duration: float) -> dict:
    return {"type": "sampler", "url": url, "start_seconds": start, "duration_seconds": duration}


class RangeServer:
    """Serves files from a dict, honouring single Range requests (unless told not to)"""

    def __init__(self, files: dict, ranges: bool = True):
        self.files, self.sent = files, 0
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = outer.files.get(self.path.lstrip("/"))
                if body is None:
                    self.send_error(404)
                    return
                rng = self.headers.get("Range") if ranges else None
                if rng:
                    a, _, b = rng.removeprefix("bytes=").partition("-")
                    a, b = int(a), min(int(b) if b else len(body) - 1, len(body) - 1)
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {a}-{b}/{len(body)}")
                    body = body[a:b + 1]
                else:
                    self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                outer.sent += len(body)

            def log_message(self, *_):
                pass

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}/"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()


@pytest.fixture
def server():
    servers = []

    def start(files, ranges=True):
        servers.append(RangeServer(files, ranges))
        return servers[-1]

    yield start
    for s in servers:
        s.close()


@needs_decoder
def test_renders_spans_of_a_long_wav_with_range_requests(server):
    long = tone(120, channels=2)
    srv = server({"long.wav": wav_bytes(long)})
    loader = AudioLoader()
    # two plays close together (one request), and one far away
    d = doc((0, sampler("long.wav", 10, 0.5)), (0.5, sampler("long.wav", 11, 0.5)), (1.0, sampler("long.wav", 90, 0.25)))
    y = render(d, sample_rate=RATE, base_url=srv.url + "song.sprs", loader=loader)

    assert len(y) == int(1.25 * RATE)
    expected = long[10 * RATE:int(10.5 * RATE), 0]
    np.testing.assert_allclose(y[:len(expected)], expected, atol=1e-4)
    assert [r for _, r in loader.fetches] == ["bytes=0-65535", loader.fetches[1][1], loader.fetches[2][1]]
    assert len(loader.fetches) == 3
    # the header probe, then 1.5 s (10-11.5, merged) and 0.25 s of 16-bit stereo: of a 3.8 MB file
    assert srv.sent == 64 * 1024 + int(1.75 * RATE) * 4

    # again, with the same loader: nothing more is fetched
    render(d, sample_rate=RATE, base_url=srv.url + "song.sprs", loader=loader)
    assert len(loader.fetches) == 3


@needs_decoder
@pytest.mark.parametrize("subtype", ["PCM_U8", "PCM_16", "PCM_24", "PCM_32", "FLOAT", "DOUBLE"])
def test_decodes_every_wav_sample_format(server, subtype):
    x = tone(3)
    srv = server({"a.wav": wav_bytes(x, subtype)})
    y = render(doc((0, sampler(srv.url + "a.wav", 1, 1))), sample_rate=RATE)
    reference, _ = soundfile.read(io.BytesIO(wav_bytes(x, subtype)), dtype="float32")
    np.testing.assert_allclose(y, reference[RATE:2 * RATE], atol=1e-2 if subtype == "PCM_U8" else 1e-4)


@needs_decoder
def test_falls_back_to_the_whole_file(server):
    x = tone(3)
    flac = io.BytesIO()
    soundfile.write(flac, x, RATE, format="FLAC")
    srv = server({"a.flac": flac.getvalue(), "b.wav": wav_bytes(x)}, ranges=False)
    y = render(doc((0, sampler(srv.url + "a.flac", 1, 0.5)), (0.5, sampler(srv.url + "b.wav", 2, 0.5))), sample_rate=RATE)
    np.testing.assert_allclose(y[:RATE // 2], x[RATE:int(1.5 * RATE)], atol=1e-4)
    np.testing.assert_allclose(y[RATE // 2:], x[2 * RATE:int(2.5 * RATE)], atol=1e-4)


@needs_decoder
def test_reads_local_files_and_data_uris(tmp_path):
    x = tone(4)
    (tmp_path / "mirror.wav").write_bytes(wav_bytes(x))
    loader = AudioLoader(local_path=lambda url: tmp_path / "mirror.wav" if url == "https://far.away/x" else None)
    data = "data:audio/wav;base64," + base64.b64encode(wav_bytes(tone(1))).decode()
    y = render(doc((0, sampler("https://far.away/x", 3, 0.5)), (0.5, sampler(data, 0, 0.25))), sample_rate=RATE, loader=loader)
    np.testing.assert_allclose(y[:RATE // 2], x[3 * RATE:int(3.5 * RATE)], atol=1e-4)
    assert loader.fetches == []
    # only the span was read from the mirror
    assert len(loader.pieces["https://far.away/x"][0].samples) == RATE // 2


@needs_decoder
def test_reports_bad_documents_and_missing_audio(server):
    with pytest.raises(codec.CodecError, match="/root"):
        render({"format": "cochlea-codec", "version": "0.2", "root": {"type": "nope"}})
    srv = server({})
    with pytest.raises(codec.ResourceError) as e:
        render(doc((0, sampler(srv.url + "gone.wav", 0, 1))), sample_rate=RATE)
    assert not e.value.transient
    # a start past the end is the decoder's to report, knowing the length
    srv = server({"a.wav": wav_bytes(tone(1))})
    with pytest.raises(codec.CodecError, match="past the end"):
        render(doc((0, sampler(srv.url + "a.wav", 5, 1))), sample_rate=RATE)


def test_recognises_codec_sounds_and_documents():
    url = "https://example.com/a.sprs"
    assert is_codec_sound({"audio_url": url, "formats": [{"url": url, "mime_type": codec.SPRS_MIME_TYPE}]})
    # a codec *format* of an ordinary sound doesn't make it one
    assert not is_codec_sound({"audio_url": "https://example.com/a.wav",
                               "formats": [{"url": url, "mime_type": codec.SPRS_MIME_TYPE}]})
    assert not is_codec_sound({"audio_url": url, "formats": []})
    assert parse_document(b'{"format": "cochlea-codec", "version": "0.2", "root": {}}')
    assert parse_document(b"RIFF....WAVE") is None
    assert parse_document(b'{"format": "something else"}') is None


def test_merges_spans():
    assert merge_spans([Span(10, 10.5), Span(11, 11.5), Span(90, 90.25)]) == [Span(10, 11.5), Span(90, 90.25)]
    assert merge_spans([Span(5, None), Span(0, 1), Span(6, 7)]) == [Span(0, 1), Span(5, None)]
