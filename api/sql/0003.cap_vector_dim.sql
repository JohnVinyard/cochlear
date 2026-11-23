-- pgvector can only build HNSW/IVFFlat indices on vectors of at most 2000
-- dimensions, so cap schema dimensions there to keep every vector schema
-- indexable.  (Large general-purpose embeddings should be truncated, e.g.
-- matryoshka-style.)

alter table annotation_schemas drop constraint annotation_schemas_vector_dim_check;
alter table annotation_schemas add constraint annotation_schemas_vector_dim_check
    check (vector_dim between 1 and 2000);
