from cochlea_client import CochleaClient


class Recording(CochleaClient):
    """Captures the query parameters the feed would send"""

    def __init__(self):
        super().__init__("http://api/v1", api_key="cka_x")
        self.sent = []

    def get(self, href_or_path, **params):
        self.sent.append((href_or_path, params))
        return {"items": []}


def test_q_and_props_become_query_parameters():
    c = Recording()
    list(c.feed_annotations(q='"piano quintet" -viola', kind="kv",
                            props={"instrument_name": "Piano", "note": 60, "ok": True, "gone": None,
                                   "meta.source": "a:b"}))
    path, params = c.sent[0]
    assert path == "/annotations"
    assert params["q"] == '"piano quintet" -viola'
    assert params["kind"] == "kv"
    # one prop parameter each (requests repeats list values), with JSON's spelling of true and null
    assert params["prop"] == ["instrument_name:Piano", "note:60", "ok:true", "gone:null", "meta.source:a:b"]


def test_no_props_sends_no_prop_parameter():
    c = Recording()
    list(c.feed_annotations(sound_id=5))
    path, params = c.sent[0]
    assert path == "/sounds/5/annotations"
    assert params["prop"] is None and params["q"] is None
