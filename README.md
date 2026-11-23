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
| `firebase/` | Firebase auth emulator image |
| `docker/` | Development image |

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
| firebase emulator UI | http://localhost:4000 |
| postgres | `localhost:5432` (user, password and database are all `cochlea`) |
| fake GCS | http://localhost:4443 |

Host ports can be overridden in `.env` (see `.env.example`). Data persists in
`.data/`; delete that directory to start fresh.

The API and the web app hot-reload. Changes to `shared/` need
`docker compose restart api`.

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
```

The API tests never start the stack themselves. They sign up fresh emulator
users, and reach Postgres directly only to grant roles.
