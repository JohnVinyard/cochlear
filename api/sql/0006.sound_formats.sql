-- Encodings of a sound (GET /sounds/{id}/formats): other files with the same
-- audio, e.g. a compressed preview, a different sample rate, or a document in
-- the cochlea codec (audio/vnd.cochlea.sprs+json). Replaces the single
-- sounds.low_quality_audio_url.
--
-- sounds.audio_url stays the sound's identity (unique, and what bots fetch).
-- A format may still use that URL, to record the original's metadata.
--
-- Like annotations, formats are immutable, attributed (anyone with
-- SOUND_EDITOR may add one to any sound, e.g. an encoder bot), and
-- soft-deleted by their creator.
create table sound_formats (
    id          bigserial primary key,
    sound_id    bigint not null references sounds (id),
    url         text not null,
    -- RFC 6838 type/subtype, lowercase, without parameters
    mime_type   text not null check (mime_type = lower(mime_type) and mime_type ~ '^[a-z0-9][a-z0-9!#$&^_.+-]*/[a-z0-9][a-z0-9!#$&^_.+-]*$'),
    -- unstructured, and varying by type: sample_rate, channels, bit_depth... (docs/sound-formats.md)
    metadata    jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
    created_by  bigint not null references users (id),
    created_at  timestamptz not null default now(),
    deleted_at  timestamptz,
    deleted_by  bigint references users (id)
);

-- the same file once per sound (not globally: nothing stops two sounds sharing one)
create unique index sound_formats_url_key on sound_formats (sound_id, url) where deleted_at is null;
create index sound_formats_sound_idx on sound_formats (sound_id, id) where deleted_at is null;

-- carry over the old column, guessing types from file extensions
insert into sound_formats (sound_id, url, mime_type, metadata, created_by, created_at)
select id,
       low_quality_audio_url,
       case
           when low_quality_audio_url ~* '\.mp3($|\?)' then 'audio/mpeg'
           when low_quality_audio_url ~* '\.(ogg|oga)($|\?)' then 'audio/ogg'
           when low_quality_audio_url ~* '\.opus($|\?)' then 'audio/opus'
           when low_quality_audio_url ~* '\.wav($|\?)' then 'audio/wav'
           when low_quality_audio_url ~* '\.flac($|\?)' then 'audio/flac'
           when low_quality_audio_url ~* '\.(m4a|mp4|aac)($|\?)' then 'audio/mp4'
           else 'application/octet-stream'
       end,
       '{"migrated_from": "low_quality_audio_url"}'::jsonb,
       created_by,
       created_at
from sounds
where low_quality_audio_url is not null;

alter table sounds drop column low_quality_audio_url;
