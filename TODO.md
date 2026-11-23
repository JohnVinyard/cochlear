# TODO

What's done, what's next, and known gaps. Keep this current: check items
off (move them to **Done**) as they land, and add new ones as they're found.
The design background is in `Audio Annotations API and App.md`.

## Next up

- [ ] First git commit of the foundation
- [ ] `codec/` placeholder: README with the open questions (VST? Web Audio vs. Rust/WASM `AudioWorkletProcessor`?) and a draft `decoder.schema.json` derived from `web-components/components/synth.ts` (`SamplerParams`, `SequencerParams`, `MusicalEvent`, `speed`)
- [ ] `infra/terraform/` placeholder: module stubs for Cloud Run (api), Cloud SQL (Postgres 17 + pgvector), GCS (blobs), Artifact Registry, Secret Manager. Firebase Hosting deploys through the firebase CLI.
- [ ] Look at the web app in a browser. It typechecks and builds, and the dev server, CORS and API calls are verified, but nobody has seen it render yet.

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

## Python client

- [ ] Tests (pytest against the compose stack)
- [ ] Retries/backoff
- [ ] Verify the conjure-backed cache (`cochlea_client/cache.py`), which hasn't been run
- [ ] Example bots: MusicNet ingestion, librosa features (chroma, mfcc, ...)

## Dev experience / CI

- [ ] CI: typecheck, unit tests, arch-test, and API tests against compose
- [ ] Changes to `shared/` need `docker compose restart api`. Add a `tsc --watch` service.
- [ ] Lint config (eslint)

## Done

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
- [x] CLI: `grant-role`, `revoke-role`, `dev-token`
- [x] Vector schemas capped at 2000 dimensions so every one is indexable (migration 0003)
- [x] Web app CRUD shell: sign-in, sounds (with `<audio-view>` and `<annotation-timeline>`), annotations, schemas, profile, API keys
- [x] Python client skeleton (feeds with `follow`, idempotent `create_sound`, batch annotations, blob upload)
