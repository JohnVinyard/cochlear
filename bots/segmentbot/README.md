# segmentbot

Follows [featurebot](../featurebot)'s onsets and gives each onset segment a
vector, for similarity search:

| Schema | Kind | One per | |
|---|---|---|---|
| `segmentbot-chroma-mfcc@1` | vector, 25-d | onset | featurebot's chroma and MFCC frames inside the segment, each averaged over time, scaled to unit length, and concatenated: `[12 chroma \| 13 MFCC]`. Spans the same time as its onset; `data.onset` is the onset annotation's id. |

Because each half has unit length, harmony (chroma) and timbre (MFCC) count
equally in cosine distance. Note that MFCC c0, which is roughly loudness,
dominates the MFCC half. Onsets whose features are silent (no direction to
compare) get no vector.

Like every vector schema, `segmentbot-chroma-mfcc@1` has its own HNSW
index (see [`api/sql/README.md`](../../api/sql/README.md)), and
`GET /v1/annotations/{id}/similar` finds a segment's nearest neighbours. On a
sound's page in the web app, each vector schema has a lane under the
waveform; click a segment to see its neighbours, in 3-d (t-SNE), and click
those to hear them.

## How it works

It reads the feed of `featurebot-onset@1` annotations, only those created by
that schema's creator (anyone can use a schema), in runs of consecutive
onsets on the same sound. For each run it fetches the sound's chroma and
MFCC blobs (`featurebot-chroma@2`, `featurebot-mfcc@2`, read through the
[time series convention](../../docs/annotation-conventions.md)) once, and
writes its vectors with `sync_annotations`.

featurebot writes a sound's onsets before its feature blobs, so segmentbot
can see onsets whose features don't exist yet. It waits for them (retrying,
without moving on) for up to `--max-wait-seconds` (an hour), then records
the run in `recent_failures` and skips it.

It's built on [`botkit`](../botkit.py), like featurebot: its cursor (the last
onset annotation id it handled) is in its user's state document, reset by
`clear-data`.

```bash
docker compose logs -f segmentbot
curl -s -H "Authorization: Bearer $(cat .data/bots/segmentbot.key)" localhost:8080/v1/users/me/state
```

## Tests

```bash
.venv/bin/pytest bots/segmentbot
```
