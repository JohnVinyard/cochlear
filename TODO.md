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

- [ ] Search, next steps (`q`, `prop` and vector search exist):
  - [ ] Relevance-ranked full-text search (`ts_rank`, using the A/B/C weights already in `search_tsv`). It can't be a feed (relevance order can't be paged by id), so a separate endpoint with its own paging
  - [ ] Range and inequality conditions on JSON (`note>60`). The GIN index only does equality; ranges need per-key B-tree expression indices, e.g. declared by the schema (like vector indices are per schema)
  - [ ] Case-insensitive `prop` matching. Not indexable on arbitrary JSON; today `q` is the fuzzy route. Could be per-key expression indices too
  - [ ] Full-text over `data` (JSON metadata on any annotation), and prop filters on it
  - [ ] Several numeric `prop` filters at once are slower (~190 ms on MusicNet notes): each tries four forms (number or string, alone or in an array). Fine for now
  - [ ] Production: adding `search_tsv` rewrote the table under a lock (73 s for 2.5M rows locally). For a big live table, add a nullable column, backfill in batches, then index concurrently
- [ ] Tombstone feed, so bots can retract derived annotations when a source annotation or sound is deleted. Today deletes are soft and simply disappear from feeds.
- [ ] Idempotency for annotation batches (e.g. an `Idempotency-Key` header). Sounds are already idempotent via unique `audio_url`, but a retried annotation POST creates duplicates.
- [ ] A deleted sound's `audio_url` stays reserved: re-registering it returns `409` with a `Location` that then returns `410`. Decide whether re-registration should be allowed.
- [ ] Links, next steps (`docs/links.md`):
  - [ ] Contextual schemas: `create_annotations` could narrow the body schema for its sound (`start_seconds` at most the duration). That means a schema per sound (by query string, or inline), not one static URL
  - [ ] A `create_version` link on an annotation schema, for its owner (today ownership of a name is only checked on insert)
  - [ ] Python client: a `follow(link, body)` helper, and bots that check links rather than catching 403s
  - [ ] A generic, schema-driven form (e.g. JSON Schema forms) for actions without a bespoke UI
- [ ] Blob annotations accept any http(s) URL. Decide whether they must point at our bucket.
- [ ] Account deletion / user soft-delete flow (the column exists; there's no endpoint)
- [ ] Rate limiting and request-size policy, beyond the body-size limits in express
- [ ] Watch feed-lock throughput (`api/src/shared/feed.ts`). If it becomes a bottleneck, switch to `(xid8, id)` ordering with an opaque cursor.
- [ ] Production build: `migrate.ts` finds `sql/` relative to source, which is wrong under `build/`. Add a production Dockerfile.
- [ ] Production config: CORS origins, `PUBLIC_BASE_URL`, real GCS credentials, Cloud SQL connection

## Web app

- [ ] The score (`/score`): try recording in a browser (the store, strip and page are untested there), including the timeline's drag-to-select; then the next steps: upload a score as a user-created sound (an `audio/vnd.cochlea.sprs+json` format, rendered to audio for annotation), open it in the codec lab, and quantise or otherwise edit it
- [ ] Save a score as a sound: upload the `.sprs` (`POST /blobs`), then register it (the form already handles `.sprs` URLs). Plays of a codec sound's rendered preview aren't recorded in the score (a `blob:` URL), and a score can't contain a codec sound (a sampler can't play a document): nesting documents would need the codec to support it
- [ ] The 3-d plot's segment loader (`audio/segments.ts`) and the codec's (`codec/resources.ts`) could share one cache
- [ ] `<codec-viewer>` timeline: zoom and scroll. A 30-minute score with a few short plays is hard to select precisely at full width. Also keyboard selection (it's pointer-only)
- [ ] Exported selections lose trailing silence: a sequencer ends when its last child does. The codec could give sequencers an optional `duration_seconds`
- [ ] The score records when the user clicked (what they meant), not when the audio started, which lags by a fetch (range request or decode). Worth measuring that lag, and keeping both

- [ ] Audio outlives the page that started it. `<audio-view>`'s `disconnectedCallback` stops its playhead and resize observer but not the sound, so leaving a sound's page mid-playback leaves audio playing with nothing on screen to stop it; the 3-d plot's `SegmentPlayer` is module-level, and also plays on with no control. Fixes: upstream, `<audio-view>` stops on disconnect (or offers a "show the playhead, don't play" mode); here, one app-wide player (a persistent "now playing" bar in `Layout`, or above `<Routes>` to cover the codec lab too) that all playback goes through, with stop, and perhaps a queue

- [ ] Favorites: look at the stars and the Favorites page in a browser. Later: public favorites (just `access: "*"`) and "most starred"; favorites of other things (users, schemas) would need annotations of more than sounds

- [ ] Look at the API reference (`/api-docs`) in a browser, including "Try it" with a copied sign-in token; and see whether Elements' styles need adjusting for the app's dark mode

- [ ] Annotation editors for every kind. Only tags exist today; also needed: text, kv, vector and blob (with upload).
- [ ] Access picker that shares with specific users. Today it's only public or private.
- [ ] Playwright UI tests against the compose stack
- [ ] Firebase Hosting deploy

## Web components

- [ ] Upstream: `<audio-view>`'s `playAudio(url, start, duration)` ignores `duration` once the view has rendered, and plays to the end of the visible view (`currentEndTimeSeconds`). Prefer an explicit duration: `const playFor = durationSeconds ?? (this.currentEndTimeSeconds ?? 5) - start` (making the parameter's default `undefined` rather than 5). Then delete the `playSpan` workaround in `web/src/elements/AudioView.tsx`

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

- [ ] Web app: play a sound's lighter format (e.g. a compressed preview), when it has one, instead of always fetching `audio_url`

- [ ] Should `json_schema` also validate `kv` values for kv-kind schemas? Today it validates only `data`, so `musicnet-note@1` has no schema for its fields.
- [ ] Mark bot users as bots (e.g. `users.is_bot`), and show them that way in the web app
- [ ] Annotation batch inserts are row-by-row inside the feed lock (`annotations/adapters/postgres.ts`). A multi-row insert (`unnest`) would speed up large ingests (currently ~3k annotations/s locally).
- [ ] Web app: show `musicnet-note@1` as a piano roll rather than as timeline lanes
- [ ] More datasets

## Bots

- [ ] A pre-trained audio embedding bot, for better similarity search than segmentbot's chroma + MFCC (which exists to exercise the pipeline). The pipeline already fits it: a `botkit.FeedBot` with its own vector schema gets an index, `/similar`, a lane and the 3-d view automatically. To decide:
    - **Dimension:** schemas are capped at 2000 dims so they stay indexable. Most audio embeddings (512–1280) fit; truncate larger ones (matryoshka-style, if the model supports it) rather than raising the cap
    - **Windowing:** models embed fixed windows (~1 s, or ~10 s), not onset segments. Fixed windows with a hop fit naturally (they're just segments), but overlapping windows overdraw each other in one lane; follow the sound feed rather than the onset feed
    - **Distance:** cosine suits most embeddings, and is what every schema uses today (see the per-schema metric item)
    - **Runtime:** its own image (torch or onnxruntime) rather than growing `docker/bots.Dockerfile`; maybe GPU access in compose; a cache for model weights
    - **Throughput:** much slower than librosa, so batch each sound's windows, and read audio from the local mirror (`AUDIO_DATA_DIR`), not S3
- [ ] Look at the vector lanes, the search panel and the 3-d plot in a browser: the search, t-SNE and range-request playback are tested, but nobody has seen or heard them yet
- [ ] segmentbot: follow deletions (a deleted onset's vector stays); maybe drop MFCC c0 (loudness) from the vector, or weight the halves
- [ ] Similarity search by an arbitrary vector (`POST /annotation-schemas/{ref}/search`), not just by an existing annotation; and a per-schema distance metric (cosine for all today)
- [ ] Lazy-load the search panel, so three.js (most of the web bundle's ~1 MB) only loads when it's used
- [ ] Barnes-Hut t-SNE (or UMAP) for more than ~1000 points; exact t-SNE is O(N²)
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

- [x] Sounds that are codec documents (`docs/sound-formats.md`): the sound page shows them in `<codec-viewer>` (annotations play through it), and renders them in the browser for the waveform and spectrogram; the "Register a sound" form recognises `.sprs` URLs. featurebot renders them with `cochlea_client.codec` (the web app's wasm decoder, via wasmtime; spans only, from mirrors or with range requests) and annotates them like any other sound

- [x] "Render .wav" on the score page: renders the score (or the selection) offline with the codec (`OpenDocument.render()`, a second at a time, with progress and cancel) to a mono 44.1 kHz 16-bit WAV, turned down if overlapping plays would clip

- [x] The codec loads only the parts of resources it needs: nodes report spans (`Node::resource_spans`; the sampler's slice), the decoder asks for the missing ones (`resource_requests`, `cc_resource_requests`) and takes partial audio (`provide_span`). The web host (`web/src/codec/resources.ts`) fetches WAV spans with range requests (merging spans within 2 s, caching pieces), falling back to whole files otherwise. Two short spans of a 79 MB MusicNet file: 0.75 s

- [x] The score page shows the score in `<codec-viewer>` (timeline, playback) above the table. The viewer has a time selection (drag; `selection`, `codec-selection-changed`, `playSelection()`, and `update()` to keep the view as a document grows); downloads export just the selection, with plays trimmed to it

- [x] Links are `{href, method, schema?}` objects and depend on who's asking: actions are linked only if the requester may do them, per each feature's domain policy (`soundPolicy`, ...). Request body schemas are served at `GET /v1/schemas/{name}`. Contextual action links on the root, sounds, formats, annotations, schemas, users, API keys and feeds; `GET /api-keys/{id}`; the web app's delete buttons and tag form follow links. Tested in `api/__tests__/api/links.test.ts` (`docs/links.md`)

- [x] Codec draft 0.1: `codec/SPEC.md`, JSON schemas, examples; Rust decoder (sampler with slice/envelope/band-pass/convolution, sequencer with compounding speed, `data:`/WAV decoding), `gammatone` extension, C-ABI WebAssembly build, CLI; browser AudioWorklet host; `<codec-viewer>` (max depth, timeline, play any node in context) at the hidden `/labs/codec`; `codec` compose service
- [x] Codec draft 0.2: `defs` and `$ref` (sounds, envelopes, patterns; instance paths plus `source` pointers; errors located in the definition), reverse-DNS extension types, `requires`; `drums.json` rewritten around patterns (172 KB → 9 KB); the viewer shows references and highlights every use of a definition

- [x] User state documents (`GET`/`PUT /v1/users/me/state`, ETag/If-Match, reset by clear-data), and `client.get_state`/`put_state`
- [x] The score: records what the user plays, anywhere in the app (via `<audio-view>`'s play events and the 3-d plot's player), timed by the click's high-resolution timestamp; the last 30 minutes in localStorage, merged across tabs; a strip along the bottom of every page while recording; a Score page (record, clear, every play with its gap to the last), and a `.sprs` download (a sequencer of samplers, URLs defined once)
- [x] Tests don't leave data behind: API tests run against their own database (`cochlea_test`) and API server, and delete their emulator accounts; `yarn cli remove-test-data` removed what earlier runs left (1,732 users, 797 sounds, 159 schemas, 96 vector indices, 6,765 annotations)
- [x] Favorites ("stars"): private `favorite@1` annotations (a seeded schema, so a "favorite" tag elsewhere doesn't count); ☆/★ on sounds, segment annotations and similarity-search results; a Favorites page. No endpoints of their own
- [x] MusicNet registers each sound's original as an `audio/wav` format, with sample rate, channels, bit depth, sample format and size read from the WAV header (all 330 done)
- [x] Sound formats (`sound_formats`, replacing `sounds.low_quality_audio_url`): other encodings of a sound, each a URL, MIME type and free-form metadata (`docs/sound-formats.md`); embedded in sounds, `/sounds/{id}/formats`, addable by any SOUND_EDITOR, deletable by their creator; in the Python client and on the sound page. The codec's file extension and media type (`.sprs`, `audio/vnd.cochlea.sprs+json`) are in `codec/SPEC.md`
- [x] Annotation search: `q` (full-text over tags, prose and JSON string values; a stored `search_tsv` column with a GIN index) and `prop=key:value` (exact JSON matching via the kv index) on every annotation feed; in the Python client (`q=`, `props=`) and on the web app's Annotations page
- [x] API reference in the web app (`/api-docs`, "API" in the nav): Stoplight Elements 9.0.29 from a CDN, rendering `/v1/openapi.json`, isolated in an iframe (`api-reference.html`) because its stylesheet carries a global CSS reset
- [x] MusicNet's bucket CORS allows `Range` (and exposes `Content-Range`), so segment playback uses range requests even where browsers preflight them
- [x] Vector search: a per-schema HNSW index for every vector schema (created with the schema, reconciled at startup), `GET /annotations/{id}/similar`; segmentbot (25-d chroma + MFCC per onset); botkit (the shared bot loop); vector lanes on the sound page, a 3-d t-SNE (from scratch, in a worker) of the neighbours with three.js, and segment playback by HTTP range requests
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
