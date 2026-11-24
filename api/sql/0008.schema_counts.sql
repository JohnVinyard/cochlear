-- How many public, live annotations each schema has (annotation_count on
-- schema resources).
--
-- Public only: a count of private annotations would leak them (how many
-- favorites exist, say), and per-viewer counts would mean a visibility check
-- over the whole table on every listing (~0.6 s at 1.7M rows, and growing).
-- Public counts are the same for everyone, so they're kept up to date here
-- by triggers, and reading them is free. (Annotations are immutable: the
-- only changes are inserts, soft deletes and clear-data's truncate.)
create table annotation_schema_counts (
    schema_id          bigint primary key references annotation_schemas (id),
    public_annotations bigint not null default 0
);

insert into annotation_schema_counts (schema_id, public_annotations)
select schema_id, count(*) from annotations where deleted_at is null and is_public group by schema_id;

create function annotation_counts_add() returns trigger language plpgsql as $$
begin
    insert into annotation_schema_counts as c (schema_id, public_annotations)
    select schema_id, count(*) from added where is_public and deleted_at is null group by schema_id
    on conflict (schema_id) do update set public_annotations = c.public_annotations + excluded.public_annotations;
    return null;
end $$;

-- a soft delete (or anything else) changing whether rows count
create function annotation_counts_change() returns trigger language plpgsql as $$
begin
    with delta as (
        select schema_id, sum(n) as n from (
            select schema_id, 1 as n from after where is_public and deleted_at is null
            union all
            select schema_id, -1 from before where is_public and deleted_at is null
        ) changes group by schema_id
    )
    insert into annotation_schema_counts as c (schema_id, public_annotations)
    select schema_id, n from delta where n <> 0
    on conflict (schema_id) do update set public_annotations = c.public_annotations + excluded.public_annotations;
    return null;
end $$;

create function annotation_counts_reset() returns trigger language plpgsql as $$
begin
    update annotation_schema_counts set public_annotations = 0;
    return null;
end $$;

create trigger annotation_counts_insert after insert on annotations
    referencing new table as added for each statement execute function annotation_counts_add();
create trigger annotation_counts_update after update on annotations
    referencing old table as before new table as after for each statement execute function annotation_counts_change();
create trigger annotation_counts_truncate after truncate on annotations
    for each statement execute function annotation_counts_reset();
