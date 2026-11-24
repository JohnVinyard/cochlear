-- Full-text search over annotations (GET /annotations?q=...): tags, prose
-- (text annotations) and the string values of JSON (kv annotations; values,
-- not keys, and not numbers, which would match far too much).
--
-- The searchable document is a *stored* generated column, not just an
-- expression index: the planner then has real statistics for it, and picks
-- the GIN index for rare terms and an id-ordered scan for common ones. With
-- an expression index alone it guessed, and rare terms took over a second
-- (they're ~1 ms like this). Adding the column rewrites the table, once.
--
-- Weights (A: tags, B: text, C: JSON values) are there for ranking, should a
-- relevance-ordered search ever exist; the feeds are ordered by id.
--
-- array_to_string is only STABLE in general (element types' output
-- functions could depend on settings), but for text[] it's immutable, which
-- generated columns require.
create function annotation_search_document(tags text[], text_value text, kv jsonb) returns tsvector
language sql immutable parallel safe as $$
    select setweight(to_tsvector('english'::regconfig, coalesce(array_to_string(tags, ' '), '')), 'A')
        || setweight(to_tsvector('english'::regconfig, coalesce(text_value, '')), 'B')
        || setweight(coalesce(jsonb_to_tsvector('english'::regconfig, kv, '["string"]'), ''::tsvector), 'C')
$$;

alter table annotations
    add column search_tsv tsvector generated always as (annotation_search_document(tags, text_value, kv)) stored;

-- queries must include the predicate for the index to apply
create index annotations_search_idx on annotations using gin (search_tsv)
    where deleted_at is null and search_tsv <> ''::tsvector;

-- superseded: search_tsv covers text annotations too
drop index annotations_text_idx;
alter table annotations drop column text_tsv;

analyze annotations;
