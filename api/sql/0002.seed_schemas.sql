-- A system user that owns the built-in annotation schemas

insert into users (user_name, about_me)
values ('system', 'Owner of the built-in annotation schemas');

insert into annotation_schemas (name, version, kind, vector_dim, json_schema, description, created_by)
select s.name, 1, s.kind::annotation_kind, s.vector_dim, s.json_schema::jsonb, s.description, u.id
from users u,
     (values
        ('tags', 'tags', null::integer, null::text,
         'Free-form tags describing a sound, or a segment of a sound'),
        ('text', 'text', null, null,
         'A prose description of a sound, or a segment of a sound'),
        ('kv', 'kv', null, null,
         'Arbitrary key/value pairs, e.g. {"instrument": "piano"}'),
        ('npz', 'blob', null, null,
         'Time-varying features (mfcc, chroma, loudness, ...) stored as a numpy .npz file'),
        ('chroma-mean', 'vector', 12, null,
         'The mean chroma vector over a sound, or a segment of a sound')
     ) as s(name, kind, vector_dim, json_schema, description)
where u.user_name = 'system';
