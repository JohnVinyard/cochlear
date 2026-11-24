# featurebot

Follows the sound feed and annotates every sound, using
[librosa](https://librosa.org) at 22.05 kHz (hop 512, about 43 frames/s):

| Schema | Kind | One per | |
|---|---|---|---|
| `featurebot-onset@1` | tags (`["onset"]`) | onset | Spans from the onset to the next one, or to the end of the sound. Onsets are detected, then backtracked to the preceding energy minimum. |
| `featurebot-chroma@2` | blob (compressed `.npz`) | sound | `chroma`: float16, shape `(12, frames)`; C, C#, … B. Drawn on the sound page. |
| `featurebot-mfcc@2` | blob (compressed `.npz`) | sound | `mfcc`: float16, shape `(13, frames)`, including c0. Drawn on the sound page. |

Features are computed in float32, and stored as float16 (`np.savez_compressed`):
about 2.8× smaller than float32, and float16's three or so significant
digits are more than chroma or MFCCs carry. (`@1` of both schemas was
uncompressed float32; featurebot no longer writes it.)

The blobs' `data` is `{"sample_rate": 22050, "hop_length": 512, "shape": [...], "timeseries": {...}}`,
so frame *i* is at *i* × 512 / 22050 seconds. `timeseries` follows the
[time series convention](../../docs/annotation-conventions.md), which is how
the web app knows to draw them under the waveform. All three are public
(`access: "*"`).

Onsets only say where events start and stop. Summarising the features over
onset segments (or anything else) is left to other bots, built on these.

## Running it

It's part of `yarn dev`, as the `featurebot` compose service:

```bash
docker compose logs -f featurebot           # what it's doing
docker compose restart featurebot           # after changing its code (it's bind-mounted)
```

The `featurebot-key` service creates the bot user, and an API key for it, the
first time it runs. The key is kept in `.data/bots/featurebot.key`; delete it
to issue a new one (e.g. after recreating the database, when the bot exits
with a 401).

Audio comes from each sound's `audio_url`, unless a mirror maps the URL to a
local file. Compose mounts `AUDIO_DATA_DIR` (set it in `.env`; see
`.env.example`) at `/audio`, and maps MusicNet's URLs to
`/audio/musicnet/{train,test}_data/<id>.wav`. Without it, MusicNet's audio
would be downloaded: about 20 GB.

Outside docker:

```bash
COCHLEA_API_KEY=$(cat .data/bots/featurebot.key) .venv/bin/python bots/featurebot/featurebot.py \
    --mirror 'https://music-net.s3.us-east-1.amazonaws.com/=/path/to/musicnet/train_data/{}.wav' \
    --once            # or --limit N; without either it polls forever
```

## State

Its place in the feed is in the bot user's state document:

```json
{"features": "1", "sounds_cursor": 878, "processed": 330, "failed": 173,
 "recent_failures": [{"sound_id": 3, "audio_url": "...", "error": "HTTP 404 fetching ...", "at": "..."}]}
```

```bash
curl -s -H "Authorization: Bearer $(cat .data/bots/featurebot.key)" localhost:8080/v1/users/me/state
```

- Sounds that can't be fetched (4xx), decoded, or are longer than
  `--max-duration-seconds` (3 hours) are recorded in `recent_failures` (the
  last 20) and skipped.
- Network errors, 5xx and 429s are retried with backoff (up to 5 minutes
  apart), indefinitely, without moving on.
- If the state changes under it (`clear-data`, or another instance), its next
  write fails with 412. It re-reads the state and carries on from there.
- Changing `FEATURES_VERSION` starts the feed over, replacing each sound's
  annotations with the new output (`sync_annotations(prune=True)`).

## Tests

```bash
.venv/bin/pytest bots/featurebot     # needs librosa: .venv/bin/pip install -r bots/featurebot/requirements.txt
```
