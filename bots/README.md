# Bots

Long-running processes that follow a feed and annotate what they find,
using the [Python client](../clients/python). Integrations
([`../integrations`](../integrations)) are one-shot imports of a dataset
from local data; bots run continuously, against whatever appears.

Each bot:

- **runs as its own bot user** (`yarn cli create-bot`), so its output is
  `GET /v1/annotations?created_by=<bot>`.
- **keeps its place in its user's state document**
  (`GET`/`PUT /v1/users/me/state`): a small, private JSON object, written
  with `If-Match`, so two instances, or a `clear-data`, can't silently undo
  each other's progress. The state lives with the data it describes, so
  `yarn cli clear-data` resets it, and the bot starts over without being told.
- **is idempotent per item.** It writes each sound's annotations with
  `client.sync_annotations`, so an item that was interrupted half-way is
  finished, not duplicated, and it saves its cursor only afterwards.
- **owns its schemas** (`<bot>-<thing>@N`), created with
  `client.ensure_schema`. A change of algorithm means new schema versions,
  and starting the feed over.
- **runs as a docker compose service** for local development, from one
  shared image (`docker/bots.Dockerfile`). The `bot-keys` service creates
  each bot's user and API key the first time (`bots/issue-keys.sh`; add new
  bots there), kept in `.data/bots/<name>.key`.

The loop itself (cursor, conditional state writes, retries and backoff,
recording failures) is [`botkit.py`](botkit.py): a bot subclasses `FeedBot`
and provides `items(cursor)` and `handle(item)`.

| Bot | Follows | Annotates with |
|---|---|---|
| [`featurebot/`](featurebot) | sounds | onsets, and frame-level chroma and MFCCs (librosa) |
| [`segmentbot/`](segmentbot) | featurebot's onsets | a 25-d chroma + MFCC vector per onset segment, for similarity search |
