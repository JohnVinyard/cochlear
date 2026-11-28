# Integrations

Scripts that bring an existing dataset into Cochlea, using the
[Python client](../clients/python). (Long-running bots that follow feeds
are in [`../bots`](../bots).) Each one:

- **runs as its own bot user.** Then "just this dataset's sounds" is
  `GET /v1/sounds?created_by=<bot>`, and its annotations are
  `GET /v1/annotations?created_by=<bot>`. Create the bot and an API key with:

  ```bash
  docker compose exec -T api yarn -s cli create-bot <name> --about "..." --info-url https://...
  ```

  This prints only the new key, so `export COCHLEA_API_KEY=$(...)` works.
  Running it again adds any missing roles and issues another key.
- **is idempotent.** Sounds are unique by `audio_url`. Annotations are
  matched by content (`client.sync_annotations`, `content_key`). A second
  run creates nothing, and a run that died part-way through picks up where
  it left off.
- **owns its schemas** (`<dataset>-<thing>@1`), created through
  `client.ensure_schema`. Schemas are immutable, so a change of shape means
  a new version.
- **doesn't download data.** It reads a local copy whose location you pass
  in.

| Integration | Dataset |
|---|---|
| [`musicnet/`](musicnet) | [MusicNet](https://zenodo.org/records/5120004): 330 classical recordings with 1M note labels |
| [`phatdrumloops/`](phatdrumloops) | [phatdrumloops.com](https://www.phatdrumloops.com/beats.php): 196 drum breaks, with the site's notes on each |
