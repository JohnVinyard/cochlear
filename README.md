# cochlea

An API and web app for describing audio on the internet with annotations
(tags, prose, key/value pairs, vectors and time-series features), for whole
sounds or time slices of them. The design background is in
[`Audio Annotations API and App.md`](Audio%20Annotations%20API%20and%20App.md).
What's done and what's next is in [`TODO.md`](TODO.md).

| Directory | What it holds |
|---|---|
| `api/` | Express + TypeScript API, organised as clean-architecture feature directories |
| `api/sql/` | Sequential database upgrade scripts |
| `web/` | Vite + React web app |
| `shared/` | Types and constants shared by `api` and `web` |
| `clients/python/` | Python client |
| `codec/` | An experimental JSON audio codec: spec, schemas, a Rust/WebAssembly decoder (see [`codec/README.md`](codec/README.md)) |
| `integrations/` | Dataset ingestion scripts (e.g. MusicNet), each run as its own bot user |
| `bots/` | Long-running bots that follow feeds and annotate: `featurebot` (onsets, chroma, MFCCs), `segmentbot` (vectors for search) |
| `docs/` | Conventions, e.g. [time series blobs](docs/annotation-conventions.md) that the web app can draw |
| `firebase/` | Firebase auth emulator image |
| `docker/` | Development images |

## Local development

You need Docker, Node 24 and yarn 1.

```bash
yarn install         # host install, for editors and running tests
yarn dev             # the whole stack, in the foreground (Ctrl-C stops it)
```

| Command | Effect |
|---|---|
| `yarn dev` | build and start everything, streaming logs |
| `yarn dev:detached` | the same, in the background; returns once every service is healthy |
| `yarn dev:logs` | follow the logs of a detached stack |
| `yarn dev:stop` | stop and remove the containers (data in `.data/` is kept) |

These are thin wrappers around `docker compose`, which you can also use directly.

| Service | URL |
|---|---|
| web app | http://localhost:5173 (sign up with any email; it's the emulator) |
| API | http://localhost:8080/v1 (spec at `/v1/openapi.json`) |
| API reference | http://localhost:5173/api-docs ("API" in the nav; Stoplight Elements, from the spec) |
| firebase emulator UI | http://localhost:4000 |
| postgres | `localhost:5432` (user, password and database are all `cochlea`) |
| fake GCS | http://localhost:4443 |
| codec lab (hidden) | http://localhost:5173/labs/codec |

Host ports can be overridden in `.env` (see `.env.example`). Data persists in
`.data/`; delete that directory to start fresh.

The API and the web app hot-reload. Changes to `shared/` need
`docker compose restart api`. The `codec` service builds the codec's
WebAssembly decoder once at startup. After changing Rust code, run
`docker compose run --rm codec` (or `yarn build-codec`) and reload the page.

The `featurebot` service annotates every sound in the feed, so it starts
working through whatever's there as soon as the stack is up
([`bots/featurebot`](bots/featurebot/README.md)). Point `AUDIO_DATA_DIR` in
`.env` at local copies of datasets, so it reads their audio from disk rather
than downloading it.

### Searching annotations

Every annotation feed (`/annotations`, `/sounds/{id}/annotations`,
`/users/{id}/annotations`) takes, besides `schema`, `kind`, `tags` and
`created_by`:

- `q`: full-text search over tags, prose and the string values of JSON
  annotations, in web-search syntax: `q=cello`, `q="piano quintet"`,
  `q=cello -viola`, `q=bach or handel`. English stemming, case-insensitive.
- `prop=key:value`: exact matches on JSON (kv) annotations, repeated for
  several (all must hold): `prop=instrument_name:Piano&prop=note:60`. Dotted
  keys reach nested objects; a value also matches as a number, boolean or null
  when it reads as one, and as an element of an array. Case-sensitive.

Both are filters on the feed: results stay oldest-first, and page with
`low_id` like any feed. The design, and its limits (no ranges, no
case-insensitive `prop`, no relevance ranking yet), are in
`api/sql/0005.annotation_search.sql` and `TODO.md`.

### Talking to the API

Every request needs `Authorization: Bearer <firebase ID token | API key>`.

```bash
T=$(docker compose exec -T api yarn -s cli dev-token you@example.com)
curl -H "Authorization: Bearer $T" localhost:8080/v1/          # follow the links from here
```

To create API keys, use the web app (`/api-keys`) or `POST /v1/api-keys` with
a firebase token.

### Roles

New users get every role except `ANNOTATION_SCHEMA_CREATOR`. Grant or
revoke roles with the CLI:

```bash
docker compose exec api yarn -s cli grant-role you@example.com ANNOTATION_SCHEMA_CREATOR
docker compose exec api yarn -s cli revoke-role you@example.com SOUND_EDITOR
```

### Bot users

Integrations and feature bots run as their own users, which sign in only
with API keys. This creates (or updates) one and prints a new key for it:

```bash
docker compose exec -T api yarn -s cli create-bot musicnet --about "Imports MusicNet"
```

### Clearing data

```bash
docker compose exec api yarn -s cli clear-data             # ids restart at 1
docker compose exec api yarn -s cli clear-data --keep-ids  # ids continue
```

This hard-deletes every sound and annotation, including soft-deleted ones.
Users, API keys, schemas and uploaded blobs are kept. Use `--keep-ids` when a
client (a bot, say) remembers its feed position (`low_id`). Otherwise it
would skip new items until their ids pass its cursor. The command refuses to
run unless `PGHOST` is `localhost`, `127.0.0.1`, `::1` or `postgres`.

To wipe everything, including users and emulator accounts, run
`yarn dev:stop && sudo rm -rf .data && yarn dev`. You need `sudo` because the
postgres data directory belongs to the container's user.

### Database changes

Add a new `api/sql/NNNN.description.sql`, then run
`docker compose run --rm migrate`. Never edit an applied script; see
[`api/sql/README.md`](api/sql/README.md), which also covers creating
per-schema vector indices.

## Tests

```bash
yarn typecheck
yarn test-unit       # domain unit tests
yarn test-api        # full-stack API tests; requires `docker compose up`
yarn arch-test       # clean-architecture dependency rules
yarn ready           # all of the above
yarn test-python     # python client, integrations and bots (needs the .venv, with librosa for featurebot)
yarn test-codec      # codec: cargo test, and the examples against the JSON schemas (needs Rust)
yarn test-all        # everything: ready, test-codec and test-python
```

`.venv` setup: `python3 -m venv .venv && .venv/bin/pip install -e 'clients/python[dev]' -r bots/featurebot/requirements.txt`.

The API tests never start the stack themselves. They sign up fresh emulator
users, and reach Postgres directly only to grant roles.
