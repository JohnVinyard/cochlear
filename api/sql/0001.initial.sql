-- Cochlea initial schema

create extension if not exists vector;

create type role as enum (
    'SOUND_READER',
    'ANNOTATION_READER',
    'ANNOTATION_SCHEMA_READER',
    'SOUND_EDITOR',
    'ANNOTATION_EDITOR',
    'ANNOTATION_SCHEMA_CREATOR',
    'API_KEY_CREATOR'
);

create type annotation_kind as enum ('tags', 'text', 'vector', 'kv', 'blob');

-- ---------------------------------------------------------------------------
-- users & roles
-- ---------------------------------------------------------------------------

create table users (
    id           bigserial primary key,
    -- null for system users (e.g. the owner of built-in schemas)
    firebase_uid text unique,
    user_name    text not null unique check (user_name ~ '^[A-Za-z0-9_.-]{1,64}$'),
    email        text,
    about_me     text not null default '',
    info_url     text,
    created_at   timestamptz not null default now(),
    deleted_at   timestamptz
);

create index users_email_idx on users (lower(email));

create table user_roles (
    user_id bigint not null references users (id),
    role    role not null,
    primary key (user_id, role)
);

-- ---------------------------------------------------------------------------
-- api keys
-- ---------------------------------------------------------------------------

create table api_keys (
    id         bigserial primary key,
    user_id    bigint not null references users (id),
    name       text not null check (length(name) between 1 and 255),
    -- hex sha-256 of the secret;  the secret itself is never stored
    key_hash   char(64) not null unique,
    key_prefix text not null,
    created_at timestamptz not null default now(),
    deleted_at timestamptz,
    deleted_by bigint references users (id)
);

create index api_keys_user_idx on api_keys (user_id) where deleted_at is null;

create table api_key_roles (
    api_key_id bigint not null references api_keys (id),
    -- api keys can never create other api keys
    role       role not null check (role <> 'API_KEY_CREATOR'),
    primary key (api_key_id, role)
);

-- ---------------------------------------------------------------------------
-- sounds
-- ---------------------------------------------------------------------------

create table sounds (
    id                    bigserial primary key,
    created_by            bigint not null references users (id),
    created_at            timestamptz not null default now(),
    audio_url             text not null unique,
    info_url              text,
    low_quality_audio_url text,
    license_type          text not null,
    title                 text,
    duration_seconds      double precision not null check (duration_seconds > 0),
    deleted_at            timestamptz,
    deleted_by            bigint references users (id)
);

create index sounds_created_by_idx on sounds (created_by, id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- annotation schemas
-- ---------------------------------------------------------------------------

create table annotation_schemas (
    id          bigserial primary key,
    name        text not null check (name ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    version     integer not null check (version > 0),
    kind        annotation_kind not null,
    vector_dim  integer check (vector_dim between 1 and 4096),
    json_schema jsonb,
    description text not null default '',
    created_by  bigint not null references users (id),
    created_at  timestamptz not null default now(),
    unique (name, version),
    check ((kind = 'vector') = (vector_dim is not null))
);

-- ---------------------------------------------------------------------------
-- annotations
-- ---------------------------------------------------------------------------

create table annotations (
    id                bigserial primary key,
    sound_id          bigint not null references sounds (id),
    schema_id         bigint not null references annotation_schemas (id),
    created_by        bigint not null references users (id),
    created_at        timestamptz not null default now(),

    -- both null: the annotation describes the whole sound
    start_seconds     double precision,
    duration_seconds  double precision,

    -- exactly one value column is set, according to the schema's kind
    tags              text[],
    text_value        text,
    text_tsv          tsvector generated always as (to_tsvector('english', coalesce(text_value, ''))) stored,
    -- dimensionless;  index per-schema with an expression index (see sql/README.md)
    vector_value      vector,
    kv                jsonb,
    blob_url          text,
    blob_content_type text,

    -- free-form, validated by the schema's json_schema (if any)
    data              jsonb,

    -- access:  is_public, or the creator, or a row in annotation_access
    is_public         boolean not null default false,

    deleted_at        timestamptz,
    deleted_by        bigint references users (id),

    check ((start_seconds is null) = (duration_seconds is null)),
    check (start_seconds is null or (start_seconds >= 0 and duration_seconds >= 0)),
    check (num_nonnulls(tags, text_value, vector_value, kv, blob_url) = 1),
    check ((blob_url is null) = (blob_content_type is null))
);

create table annotation_access (
    annotation_id bigint not null references annotations (id),
    user_id       bigint not null references users (id),
    primary key (annotation_id, user_id)
);

create index annotation_access_user_idx on annotation_access (user_id, annotation_id);

create index annotations_sound_idx      on annotations (sound_id, id)    where deleted_at is null;
create index annotations_created_by_idx on annotations (created_by, id)  where deleted_at is null;
create index annotations_schema_idx     on annotations (schema_id, id)   where deleted_at is null;
create index annotations_tags_idx       on annotations using gin (tags)  where deleted_at is null and tags is not null;
create index annotations_text_idx       on annotations using gin (text_tsv) where deleted_at is null and text_value is not null;
create index annotations_kv_idx         on annotations using gin (kv jsonb_path_ops) where deleted_at is null and kv is not null;
