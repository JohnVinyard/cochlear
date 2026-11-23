"""
PLACEHOLDER: local caching of *immutable* resources with conjure
(https://github.com/JohnVinyard/conjure).

Sounds, annotations and annotation schemas never change once created (they
can only be deleted), so single-resource GETs can be cached forever. Feeds
must never be cached.

    from cochlea_client.cache import cached_client
    client = cached_client(CochleaClient(...), "/tmp/cochlea-cache")

Requires `pip install cochlea-client[cache]`.
"""

from __future__ import annotations

from .client import CochleaClient


def cached_client(client: CochleaClient, path: str) -> CochleaClient:
    from conjure import LiteralFunctionIdentifier, SqliteCollection, conjure  # type: ignore
    from conjure.serialize import JSONDeserializer, JSONSerializer  # type: ignore

    storage = SqliteCollection(path)

    def cache(name: str, fn):
        # a literal identifier keeps keys stable across code changes
        return conjure(
            content_type="application/json",
            storage=storage,
            func_identifier=LiteralFunctionIdentifier(name),
            serializer=JSONSerializer(),
            deserializer=JSONDeserializer(),
        )(fn)

    client.get_sound = cache("sound", client.get_sound)  # type: ignore[method-assign]
    client.get_annotation = cache("annotation", client.get_annotation)  # type: ignore[method-assign]
    client.get_schema = cache("schema", client.get_schema)  # type: ignore[method-assign]
    return client
