# cochlea-client (Python)

```bash
pip install -e 'clients/python[dev]'        # or: uv pip install -e ...
```

```python
from cochlea_client import CochleaClient

client = CochleaClient("http://localhost:8080/v1", api_key="cka_...")

# a feature bot: follow the sound feed forever, keeping its place in its
# user's state document (a small, private JSON object, reset by clear-data)
state = client.get_state()
for sound in client.feed_sounds(low_id=state.document.get("cursor"), follow=True):
    client.sync_annotations(sound["id"], [{"schema": "tags@1", "tags": ["seen"]}], access="*")
    # If-Match: raises StateConflict if anyone else wrote the state since
    state = client.put_state({"cursor": sound["id"]}, if_match=state.etag)
```

See [`bots/featurebot`](../../bots/featurebot) for a complete one.

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

## Codec documents

`cochlea_client.codec` renders cochlea codec documents (`.sprs`, see
[`codec/SPEC.md`](../../codec/SPEC.md)) with the web app's WebAssembly
decoder, run by wasmtime (`pip install 'cochlea-client[codec]'`, and build
the decoder with `yarn build-codec`, or point `COCHLEA_CODEC_WASM` at it):

```python
from cochlea_client import codec

if codec.is_codec_sound(sound):   # a format at its audio_url says it's a document
    y = codec.render(requests.get(sound["audio_url"]).json(), sample_rate=22050, base_url=sound["audio_url"])
```

Only the parts of resources the document plays are loaded: WAV files over
HTTP with Range requests, local files partially; anything else whole.
`codec.AudioLoader(local_path=...)` maps URLs to local copies, and keeps
what it loads for the next document.

## Tests

```bash
pytest clients/python/tests integrations
```
