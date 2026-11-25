# Links

Every API resource has `links`: what the client can do next, keyed by
relation. Start at `GET /v1/` and follow them.

```json
"links": {
  "self":               { "href": "http://localhost:8080/v1/sounds/12", "method": "GET" },
  "annotations":        { "href": "http://localhost:8080/v1/sounds/12/annotations", "method": "GET" },
  "create_annotations": {
    "href": "http://localhost:8080/v1/sounds/12/annotations",
    "method": "POST",
    "schema": "http://localhost:8080/v1/schemas/CreateAnnotationsRequestBody"
  },
  "delete":             { "href": "http://localhost:8080/v1/sounds/12", "method": "DELETE" }
}
```

- **`href`** is absolute. A client that reaches the API by another address
  (inside docker compose, `api:8080`) keeps the path and query and uses its
  own base URL; the Python client does this.
- **`method`** is the HTTP method to use.
- **`schema`**, for JSON bodies (POST, PUT, PATCH), is the URL of the JSON
  schema the body must match. `GET /v1/schemas/{name}` serves it without
  credentials, as a standalone draft-07 document whose `$id` is its URL. It
  is the same schema the API validates the request against. A blob upload
  (`upload_blob`) has no `schema`: its body is the file itself.

Names: reads are nouns (`self`, `sound`, `annotations`), and actions are
verbs (`delete`, `update`, `create_annotations`, `add_format`). In a feed
page, `links.create` adds to what the feed lists, and `next` (outside
`links`) is the next page.

## Links depend on who's asking

A link to an action appears only if the requester may do it, according to
the same rules the API enforces. Each feature's `domain.ts` has a policy,
such as `soundPolicy`. The use cases enforce it, and the HTTP adapters use
it to decide which links to render. So a UI can hide or disable what the
user can't do, without knowing the rules itself:

| Link | Shown when |
| --- | --- |
| root `create_sound`, sound feed `create` | `SOUND_EDITOR` |
| sound `create_annotations`, a sound's annotation feed `create` | `ANNOTATION_EDITOR` |
| sound `add_format`, formats `create` | `SOUND_EDITOR` (on any sound) |
| sound / format / annotation `delete` | its creator, with `SOUND_EDITOR` / `ANNOTATION_EDITOR` |
| annotation `similar` | it's a vector annotation |
| root `create_annotation_schema`, schema feed `create` | `ANNOTATION_SCHEMA_CREATOR` |
| root `upload_blob` | `ANNOTATION_EDITOR` |
| `api_keys`, `create_api_key` | the web app (not an API key), with `API_KEY_CREATOR` |
| user `update`, `state`, `update_state` | it's you |
| reads such as `sounds`, `annotations`, `sound`, `schema` | the matching `*_READER` role |

Links say what the requester's roles and relation to the resource allow.
They don't promise that a particular body will be accepted. For example,
`create_annotation_schema` doesn't know whether you own the schema name you
pick, and `create_annotations` doesn't check your segment against the
sound's duration.

## Tests

`api/__tests__/api/links.test.ts` checks both directions. When a link is
present, following it works, with a body that the fetched schema accepts.
When it's absent, the request it would have made is refused. It also crawls
the GET links from the entry point, for a user and for a restricted API key,
and expects every one to return 200.
