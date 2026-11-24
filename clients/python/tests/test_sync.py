from cochlea_client import CochleaClient


class Fake(CochleaClient):
    """sync_annotations' collaborators, in memory"""

    def __init__(self, existing):
        super().__init__("http://api/v1", api_key="cka_x")
        self._my_id = 7
        self.server = [{"id": i + 1, **a} for i, a in enumerate(existing)]
        self.created, self.deleted = [], []

    def feed_annotations(self, **_):
        return iter(self.server)

    def create_annotations(self, sound_id, batch, *, access):
        self.created += batch

    def delete_annotation(self, annotation_id):
        self.deleted.append(annotation_id)


a = {"schema": "tags@1", "tags": ["a"]}
b = {"schema": "tags@1", "tags": ["b"]}
old = {"schema": "tags@1", "tags": ["old"]}


def test_creates_only_whats_missing():
    c = Fake([a, old])
    r = c.sync_annotations(1, [a, b], access="*")
    assert (c.created, c.deleted, r.created, r.existing, r.deleted) == ([b], [], 1, 1, 0)


def test_prune_deletes_the_rest_afterwards():
    c = Fake([a, old, a])
    r = c.sync_annotations(1, [a, b], access="*", prune=True)
    # one of the two a's is surplus, and old isn't wanted at all
    assert c.created == [b] and sorted(c.deleted) == [2, 3] and r.deleted == 2
