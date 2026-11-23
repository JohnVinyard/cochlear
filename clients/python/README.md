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
