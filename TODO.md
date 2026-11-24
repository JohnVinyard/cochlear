# TODO

What's done, what's next, and known gaps. Keep this current: check items
off (move them to **Done**) as they land, and add new ones as they're found.
The design background is in `Audio Annotations API and App.md`.

## Next up

- [ ] First git commit of the foundation
- [ ] `infra/terraform/` placeholder: module stubs for Cloud Run (api), Cloud SQL (Postgres 17 + pgvector), GCS (blobs), Artifact Registry, Secret Manager. Firebase Hosting deploys through the firebase CLI.
- [ ] Look at the web app in a browser. It typechecks and builds, and the dev server, CORS and API calls are verified, but nobody has seen it render yet.

## To think about

- [ ] **Content-addressable annotations.** Today identity lives in the client: `content_key` (in `clients/python/cochlea_client/client.py`) hashes schema, segment, value and `data`, and `sync_annotations` reads a sound's existing annotations and creates only the missing ones. That works, but it's racy across concurrent runs, every run costs a full read, and every client needs an identical hash. Open questions:
  - **Scope:** unique per `(created_by, sound_id)`, or global, so two bots asserting the same fact collide?
  - **Canonical form:** who defines it? Float handling (`4.0` vs `4`, float32 vectors), key order, tag normalisation; maybe RFC 8785 JSON canonicalisation. Shared test vectors between server and clients.
  - **Duplicates:** respond `409` + `Location` (like sounds), or a batch option like `on_conflict: "skip"` that returns the existing annotations? What about legitimately identical annotations? `sync_annotations` treats input as a multiset today.
  - **Addressing:** expose the key on the resource? Make it fetchable (`/annotations/by-key/{hash}`), or even the id?
  - **Soft deletes:** does re-posting a deleted annotation give `410`, or create it again?
  - **Access:** is it part of identity? (Not today.)
  - **Rollout:** a migration to backfill existing rows (about 1.09M MusicNet annotations locally)
  - **Sounds:** they're unique by `audio_url` today. Should they also be addressable by a hash of the audio content?

## API

- [ ] Search endpoints. The indices exist; the routes don't.
  - [ ] Vector similarity search per vector schema. Indices are created by hand (`api/sql/README.md`). Queries must use the `vector_value::vector(N)` cast and the `schema_id = <id>` condition.
  - [ ] Full-text search over `text` annotations (`text_tsv`)
  - [ ] Key/value search over `kv` annotations (`kv @> ...`)
- [ ] Tombstone feed, so bots can retract derived annotations when a source annotation or sound is deleted. Today deletes are soft and simply disappear from feeds.
- [ ] Idempotency for annotation batches (e.g. an `Idempotency-Key` header). Sounds are already idempotent via unique `audio_url`, but a retried annotation POST creates duplicates.
- [ ] A deleted sound's `audio_url` stays reserved: re-registering it returns `409` with a `Location` that then returns `410`. Decide whether re-registration should be allowed.
- [ ] `GET /api-keys/{id}`. The `self` link exists but only `DELETE` is routed.
- [ ] Blob annotations accept any http(s) URL. Decide whether they must point at our bucket.
- [ ] Account deletion / user soft-delete flow (the column exists; there's no endpoint)
- [ ] Rate limiting and request-size policy, beyond the body-size limits in express
- [ ] Watch feed-lock throughput (`api/src/shared/feed.ts`). If it becomes a bottleneck, switch to `(xid8, id)` ordering with an opaque cursor.
- [ ] Production build: `migrate.ts` finds `sql/` relative to source, which is wrong under `build/`. Add a production Dockerfile.
- [ ] Production config: CORS origins, `PUBLIC_BASE_URL`, real GCS credentials, Cloud SQL connection

## Web app

- [ ] Annotation editors for every kind. Only tags exist today; also needed: text, kv, vector and blob (with upload).
- [ ] Access picker that shares with specific users. Today it's only public or private.
- [ ] Playwright UI tests against the compose stack
- [ ] Firebase Hosting deploy

## Web components

- [ ] Upstream `<annotation-timeline>` (`web/src/elements/annotation-timeline.ts`) to https://github.com/JohnVinyard/web-components
- [ ] Sync `<annotation-timeline>` with `<audio-view>` zoom/scroll. Today it maps the whole duration to its own width.
- [ ] In web-components: make `<audio-view>` property setters reflect to attributes, so React 19 (which sets properties) works without the `AudioView.tsx` wrapper
- [ ] Ship type declarations (`.d.ts`) from web-components, replacing `web/src/elements/web-components.d.ts`

## Codec

The open questions in `codec/SPEC.md` come first, especially parameter overrides on references, and extensions as WebAssembly.

- [ ] Look at `/labs/codec` in a browser. The decoder, the WASM wrapper (under Node) and the dev server are verified, but nobody has heard it play or seen the viewer render yet.
- [ ] Build the document in a Worker rather than in the AudioWorklet constructor, which blocks the audio thread while samplers precompute (convolution is the slow part)
- [ ] Streaming voices for long sources and impulse responses (today leaf modules precompute their whole output)
- [ ] `<codec-viewer>`: waveform of the rendered output; zoom; show which nodes are playing; edit parameters in place
- [ ] Upstream `<codec-viewer>` to web-components. It imports its worklet through Vite (`?worker&url`), so it needs a bundler-neutral way to find it.
- [ ] Higher-quality resampling (linear today)
- [ ] `wasm-opt` the WebAssembly build (610 KB today)
- [ ] An encoder: matching pursuit into timed sampler events
- [ ] Render each definition once and share its output between uses (references make documents small, but each use is still built separately)
- [ ] Pick the namespace for first-party extensions: `org.cochlea.*` is a placeholder for a domain we control
- [ ] Bridge to the API: e.g. a `musicnet-note@1` → codec document transform (`codec/examples/generate.py` does this from local files)

## Integrations

- [ ] Should `json_schema` also validate `kv` values for kv-kind schemas? Today it validates only `data`, so `musicnet-note@1` has no schema for its fields.
- [ ] Mark bot users as bots (e.g. `users.is_bot`), and show them that way in the web app
- [ ] Annotation batch inserts are row-by-row inside the feed lock (`annotations/adapters/postgres.ts`). A multi-row insert (`unnest`) would speed up large ingests (currently ~3k annotations/s locally).
- [ ] Web app: show `musicnet-note@1` as a piano roll rather than as timeline lanes
- [ ] More datasets

## Bots

- [ ] The next bot: summarise featurebot's chroma and MFCC frames over its onset segments, as vector annotations (and then a pgvector index per vector schema, for search)
- [ ] Blob URLs are built for the host (`BLOB_PUBLIC_URL_TEMPLATE`, `localhost:4443`), so bots in containers can't download them. Rebase them like API links, or give bots an internal URL.
- [ ] featurebot: tell transient decode problems from permanent ones (today any decode error skips the sound for good)
- [ ] A way to re-run a bot over particular sounds (e.g. after fixing a failure), short of resetting its whole state
- [ ] Bot liveness: surface each bot's state (cursor, failures) in the web app, e.g. on its user page
- [ ] Look at the sound page's `<timeseries-view>`s in a browser: the `.npz` reader is tested against numpy's output, and the page gets the right annotations, but nobody has seen them drawn yet
- [ ] `<timeseries-view>`: zoom/scroll in step with `<audio-view>` (like `<annotation-timeline>`, it always shows the whole sound); a colour scale legend; arrays with more than 2 axes
- [ ] Should `data.timeseries` be declared by the schema (e.g. its `json_schema` or a schema-level field) rather than repeated on every annotation?
- [ ] featurebot onsets on dense music are very short (~4/s for MusicNet); tune `onset_detect`, or let consumers merge them

## Python client

- [ ] Tests (pytest against the compose stack)
- [ ] Retries/backoff
- [ ] Verify the conjure-backed cache (`cochlea_client/cache.py`), which hasn't been run
- [ ] Example feature bots: librosa features (chroma, mfcc, ...)

## Dev experience / CI

- [ ] CI: typecheck, unit tests, arch-test, and API tests against compose
- [ ] Changes to `shared/` need `docker compose restart api`. Add a `tsc --watch` service.
- [ ] Lint config (eslint)

## Done

- [x] Codec draft 0.1: `codec/SPEC.md`, JSON schemas, examples; Rust decoder (sampler with slice/envelope/band-pass/convolution, sequencer with compounding speed, `data:`/WAV decoding), `gammatone` extension, C-ABI WebAssembly build, CLI; browser AudioWorklet host; `<codec-viewer>` (max depth, timeline, play any node in context) at the hidden `/labs/codec`; `codec` compose service
- [x] Codec draft 0.2: `defs` and `$ref` (sounds, envelopes, patterns; instance paths plus `source` pointers; errors located in the definition), reverse-DNS extension types, `requires`; `drums.json` rewritten around patterns (172 KB → 9 KB); the viewer shows references and highlights every use of a definition

- [x] User state documents (`GET`/`PUT /v1/users/me/state`, ETag/If-Match, reset by clear-data), and `client.get_state`/`put_state`
- [x] Time series convention for `.npz` blob annotations (`docs/annotation-conventions.md`, `TimeseriesData`); `<timeseries-view>` (canvas heatmap/line, dependency-free `.npz` reader) on the sound page; a `kind` filter on annotation feeds; `sync_annotations(prune=True)`; featurebot v2 writes the convention
- [x] featurebot (`bots/featurebot`): follows the sound feed; onsets, frame-level chroma and MFCC blobs; a compose service with its own key and local audio mirrors
- [x] Python client: API links (`next`) are followed on the client's own base URL, so it works inside docker compose
- [x] MusicNet integration (`integrations/musicnet`): sounds, metadata, tags and note labels. Idempotent, and runs as the `musicnet` bot.
- [x] `yarn cli create-bot` (bot users that authenticate only with API keys)
- [x] Python client: `content_key`, `ensure_schema`, `sync_annotations` (re-runnable ingestion), and pytest unit tests

- [x] `yarn dev` / `dev:detached` / `dev:logs` / `dev:stop`
- [x] Firebase emulator accounts persist across restarts (exported to `.data/firebase/export`)
- [x] Repo layout: yarn 1 workspaces (`shared`, `api`, `web`), Node 24
- [x] docker compose dev stack: postgres + pgvector, firebase auth emulator, fake-gcs-server, migrate, api (hot reload), web (Vite). Data persists in `.data/`.
- [x] Sequential migration runner with checksums (`api/sql/NNNN.*.sql`)
- [x] Database schema: users and roles, API keys and scoped roles, sounds, versioned annotation schemas, annotations (tags/text/vector/kv/blob) with access control and indices
- [x] Authentication: firebase ID tokens (auto-provisioned users with default roles) and `cka_` API keys
- [x] Authorization: role checks in the domain. A key's roles are intersected with its owner's current roles. `API_KEY_CREATOR` can never be granted to a key.
- [x] CRUD and feed endpoints for users, API keys, sounds, annotation schemas, annotations, blobs, with HATEOAS links and `{items, next}` paging
- [x] Gap-free feeds: ids commit in order, via an advisory lock on insert
- [x] Annotation access: private (`null`), public (`"*"`), or a list of user ids. Visibility is applied to GETs and to all feeds.
- [x] Hand-written OpenAPI 3.1 spec, sharing JSON schemas with ajv validation (`GET /v1/openapi.json`)
- [x] Clean-architecture rules enforced by dependency-cruiser (`yarn arch-test`)
- [x] Unit tests (domain) and full-stack API tests (against compose)
- [x] CLI: `grant-role`, `revoke-role`, `dev-token`, `clear-data [--keep-ids]` (local databases only)
- [x] Vector schemas capped at 2000 dimensions so every one is indexable (migration 0003)
- [x] Web app CRUD shell: sign-in, sounds (with `<audio-view>` and `<annotation-timeline>`), annotations, schemas, profile, API keys
- [x] Python client skeleton (feeds with `follow`, idempotent `create_sound`, batch annotations, blob upload)
