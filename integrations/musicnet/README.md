# MusicNet

[MusicNet](https://zenodo.org/records/5120004) (CC BY 4.0) has 330 freely
licensed classical recordings, with about 1.07M note labels aligned to the
audio. The audio is referenced from the mirror at
`https://music-net.s3.us-east-1.amazonaws.com/{id}`.

| Annotation | Schema | Per piece |
|---|---|---|
| The `musicnet_metadata.csv` row (composer, composition, movement, ensemble, source, transcriber, catalog_name), plus `musicnet_id` and `split` | `musicnet-metadata@1` (kv, whole sound) | 1 |
| Composer, ensemble, and the instruments that play | `tags@1` (whole sound) | 1 |
| One note: the label row (`start_time`/`end_time` in samples, `instrument` as a 1-based GM program, `note` as a MIDI pitch, `start_beat`, `end_beat`, `note_value`) plus `instrument_name`. The segment is the note's span. | `musicnet-note@1` (kv) | ~3,300 |

Each sound also lists its original recording as a **format**
([`docs/sound-formats.md`](../../docs/sound-formats.md)): `audio/wav`, with
the `sample_rate`, `channels`, `bit_depth`, `sample_format` and `size_bytes`
read from the local copy's header (all 330 are 44.1 kHz, mono, 32-bit
float). Pieces whose audio isn't in `--data-dir` get no format, since there's
nothing to say about it. Re-running adds formats to sounds that don't have
them yet; `--no-notes` makes that quick (about 80 s), skipping the notes.

## Running it

```bash
python3 -m venv .venv && .venv/bin/pip install -e clients/python   # once
export COCHLEA_API_KEY=$(docker compose exec -T api yarn -s cli create-bot musicnet \
    --about "Imports the MusicNet dataset" --info-url https://zenodo.org/records/5120004)

.venv/bin/python integrations/musicnet/musicnet.py --data-dir ~/workspace/audio-data/musicnet
```

| Option | |
|---|---|
| `--data-dir` (env `MUSICNET_DATA_DIR`) | local copy of the dataset: `musicnet_metadata.csv`, `{train,test}_labels/`, and optionally `{train,test}_data/` (read only for exact durations from the WAV headers) |
| `--api-url` (env `COCHLEA_API_URL`) | default `http://localhost:8080/v1` |
| `--api-key` (env `COCHLEA_API_KEY`) | the bot's key |
| `--audio-base-url` | default `https://music-net.s3.us-east-1.amazonaws.com` |
| `--ids 1727,1728`, `--limit N` | a subset |
| `--no-notes` | metadata and tags only |
| `--access public\|private` | default `public` |
| `--dry-run` | read and map everything, but don't call the API |

Locally, the whole dataset takes about 5 minutes. A re-run takes about
90 seconds, which is mostly reading back the existing annotations to compare
them, and creates nothing.

## Some queries

```bash
H="Authorization: Bearer $COCHLEA_API_KEY"
curl -H "$H" "localhost:8080/v1/sounds?created_by=<bot id>"
curl -H "$H" "localhost:8080/v1/annotations?created_by=<bot id>&tags=Bach"
curl -H "$H" "localhost:8080/v1/sounds/<id>/annotations?schema=musicnet-note@1&time_range=10-12"
```
