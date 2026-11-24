# Database upgrade scripts

Files named `NNNN.description.sql` are applied in numeric order by
`yarn workspace @cochlea/api migrate` (the `migrate` service in
docker compose), each in its own transaction, and recorded in
`schema_migrations`.

- **Never edit a script that has been applied.** The runner stores a checksum
  and refuses to continue if an applied script changes. Write a new script.
- Version numbers must be unique.

## Per-schema vector indices

`annotations.vector_value` is a dimensionless `vector`, because each
annotation schema of kind `vector` has its own dimension. pgvector can only
index fixed-dimension vectors (of at most 2000 dimensions, which is why
schemas are capped at 2000), so **every vector schema gets its own partial
expression index**, created automatically:

- in the background, as soon as the schema is created (`POST /v1/annotation-schemas`):
  building one scans the whole `annotations` table, so it can take a while, and
  until it exists searches still work, by sequential scan;
- at API startup, for any vector schema without a valid one (older schemas,
  or a `create index concurrently` that was interrupted).

For a schema with id 67 and dimension 25 it's:

```sql
create index concurrently if not exists annotations_vector_67
    on annotations using hnsw ((vector_value::vector(25)) vector_cosine_ops)
    where schema_id = 67;
```

Queries must use the same expression and predicate for the planner to use
it, which is why both are built in one place, `src/shared/db/vectors.ts`.
`GET /v1/annotations/{id}/similar` uses them, with pgvector's iterative
scans (`hnsw.iterative_scan = relaxed_order`), so visibility and deletion
filters don't starve the index of results. Check a plan with:

```sql
begin;
set local hnsw.iterative_scan = relaxed_order;
explain analyze
select id from annotations
where schema_id = 67 and deleted_at is null
order by (vector_value::vector(25)) <=> '[...]'::vector(25)
limit 100;      -- expect: Index Scan using annotations_vector_67
rollback;
```

Distance is cosine for every schema, for now.
