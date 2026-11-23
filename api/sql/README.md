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
schemas are capped at 2000), so indices are created by hand, per schema,
as partial expression indices. For example, for `chroma-mean@1`
(dimension 12):

```sql
-- find the schema id
select id from annotation_schemas where name = 'chroma-mean' and version = 1;

create index concurrently annotations_vector_chroma_mean_1_idx
    on annotations
    using hnsw ((vector_value::vector(12)) vector_cosine_ops)
    where schema_id = <id> and deleted_at is null;
```

Queries must use the same expression and predicate for the index to apply:

```sql
select id from annotations
where schema_id = <id> and deleted_at is null
order by vector_value::vector(12) <=> '[...]'::vector(12)
limit 10;
```

When an index is permanent, capture it in a numbered script. `create index
concurrently` can't run inside a transaction, so use a plain `create index`
in the script.
