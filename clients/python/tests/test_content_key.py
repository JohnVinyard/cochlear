from cochlea_client import content_key


def test_same_content_same_key_regardless_of_key_order_and_extra_fields():
    posted = {"schema": "kv@1", "kv": {"a": 1, "b": "x"}, "access": "*"}
    returned = {
        "id": 7, "created_by": 3, "created_at": "2026-01-01T00:00:00Z", "sound_id": 1,
        "schema": "kv@1", "kind": "kv", "start_seconds": None, "duration_seconds": None,
        "end_seconds": None, "kv": {"b": "x", "a": 1}, "data": None, "access": None, "links": {},
    }
    assert content_key(posted) == content_key(returned)


def test_integral_floats_match_ints_like_javascript():
    assert content_key({"schema": "kv@1", "kv": {"beat": 4.0}}) == content_key({"schema": "kv@1", "kv": {"beat": 4}})
    assert content_key({"schema": "kv@1", "kv": {"beat": 4.5}}) != content_key({"schema": "kv@1", "kv": {"beat": 4}})


def test_vectors_compare_at_float32_precision():
    posted = {"schema": "chroma-mean@1", "vector": [0.1, 0.2]}
    returned = {"schema": "chroma-mean@1", "vector": [0.10000000149011612, 0.20000000298023224]}
    assert content_key(posted) == content_key(returned)


def test_tags_are_trimmed_and_deduplicated_like_the_api():
    assert content_key({"schema": "tags@1", "tags": [" a", "b", "a"]}) == content_key({"schema": "tags@1", "tags": ["a", "b"]})
    assert content_key({"schema": "tags@1", "tags": ["a", "b"]}) != content_key({"schema": "tags@1", "tags": ["b", "a"]})


def test_segment_schema_data_and_value_all_matter():
    base = {"schema": "kv@1", "start_seconds": 1.5, "duration_seconds": 2, "kv": {"a": 1}, "data": {"d": 1}}
    key = content_key(base)
    for change in (
        {"schema": "kv@2"},
        {"start_seconds": 1.6},
        {"duration_seconds": 2.1},
        {"kv": {"a": 2}},
        {"data": None},
    ):
        assert content_key({**base, **change}) != key
    whole = {"schema": "kv@1", "kv": {"a": 1}}
    assert content_key(whole) == content_key({**whole, "start_seconds": None, "duration_seconds": None, "data": None})


def test_access_is_not_content():
    a = {"schema": "kv@1", "kv": {"a": 1}}
    assert content_key({**a, "access": "*"}) == content_key({**a, "access": None})
