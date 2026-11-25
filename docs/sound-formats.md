# Sound formats

A sound's **formats** (`GET /v1/sounds/{id}/formats`, and embedded in every
sound resource) are other encodings of the same audio: a compressed preview,
a different sample rate, a document in the cochlea codec. `sounds.audio_url`
stays the sound's identity and canonical source; a format may also use that
URL, to describe the original.

Each format has a `url`, a `mime_type` (RFC 6838 `type/subtype`, stored
lowercase, without parameters) and a free-form `metadata` object (at most
16 KB). Formats are immutable; anyone with `SOUND_EDITOR` may add one to any
sound (e.g. an encoder bot), and only its creator may delete it.

## Metadata

The API doesn't check `metadata`, but tools read these keys when they're
there. Use them where they apply, in these units, and add whatever else is
useful.

| Key | | Applies to |
|---|---|---|
| `sample_rate` | Hz, e.g. `44100` | PCM and compressed audio |
| `channels` | e.g. `1`, `2` | PCM and compressed audio |
| `bit_depth` | bits per sample, e.g. `16`, `24` | PCM (`audio/wav`, `audio/flac`) |
| `sample_format` | `int` or `float` | PCM |
| `bitrate` | bits per second, e.g. `128000` | compressed audio (`audio/mpeg`, `audio/ogg`, `audio/opus`, `audio/mp4`) |
| `codec` | e.g. `opus`, `vorbis`, `aac`, `mp3` | containers that can hold several codecs |
| `size_bytes` | the file's size | any |
| `duration_seconds` | when it differs from the sound's (e.g. a trimmed preview) | any |
| `version` | the document's format version, e.g. `"0.2"` | `audio/vnd.cochlea.sprs+json` |
| `requires` | the modules it needs, e.g. `{"org.cochlea.gammatone": "0.1"}` | `audio/vnd.cochlea.sprs+json` |

For example, MusicNet's originals would be
`{"url": "https://music-net.s3.us-east-1.amazonaws.com/1727", "mime_type": "audio/wav",
"metadata": {"sample_rate": 44100, "channels": 1, "bit_depth": 32, "sample_format": "float"}}`.

## Sounds that are codec documents

A sound's audio may be a cochlea codec document: its `audio_url` is a
`.sprs` file, and a format at the **same URL** has the media type
`audio/vnd.cochlea.sprs+json`. There may be no other audio for it. The web
app shows such a sound in its codec viewer, and renders it when it needs a
waveform or spectrogram. Bots render it to analyse it (featurebot does, with
`cochlea_client.codec`). The web app's "Register a sound" form recognises a
`.sprs` URL, works out its duration with the codec, and adds the format.

```json
{ "audio_url": "https://example.com/score.sprs", "duration_seconds": 12.5, "license_type": "...",
  "formats": [{ "url": "https://example.com/score.sprs", "mime_type": "audio/vnd.cochlea.sprs+json",
                "metadata": { "version": "0.2" } }] }
```

A codec format at a *different* URL is just another encoding of an ordinary
sound.

Common media types: `audio/wav`, `audio/flac`, `audio/mpeg` (MP3),
`audio/ogg` (Vorbis or Opus in Ogg), `audio/opus`, `audio/mp4` (AAC, ALAC),
`audio/webm`, and `audio/vnd.cochlea.sprs+json` for the codec
([`codec/SPEC.md`](../codec/SPEC.md#files-and-media-type)).
