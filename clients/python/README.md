# cochlea-client (Python)

```bash
pip install -e 'clients/python[dev]'        # or: uv pip install -e ...
```

```python
from cochlea_client import CochleaClient

client = CochleaClient("http://localhost:8080/v1", api_key="cka_...")

# a feature bot: follow the sound feed forever, from a persisted offset
for sound in client.feed_sounds(low_id=load_offset(), follow=True):
    client.create_annotations(sound["id"], [{"schema": "tags@1", "tags": ["seen"]}], access="*")
    save_offset(sound["id"])
```

Create an API key in the web app (`/api-keys`), giving it only the roles the
bot needs.

`cochlea_client.cache` is a placeholder for conjure-backed caching of
immutable resources. It's an optional extra because conjure is a heavy
install.

## Re-runnable ingestion

Dataset integrations (see [`integrations/`](../../integrations)) need to be
safe to run twice:

```python
client.ensure_schema("my-dataset-note@1", "kv", description="...")   # creates it, or checks it matches
sound = client.create_sound(audio_url=..., ...)                     # existing sound on a duplicate URL
result = client.sync_annotations(sound["id"], annotations, access="*")
print(result.created, result.existing)
```

`sync_annotations` reads the annotations you've already made on the sound,
compares them by `content_key` (a hash of schema, segment, value and `data`),
and creates only the missing ones. For it to work, the same input must always
produce the same annotations.

## Tests

```bash
pytest clients/python/tests integrations
```
