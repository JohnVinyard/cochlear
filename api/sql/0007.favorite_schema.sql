-- Favorites ("stars"): a user's private annotation of a sound, or a segment
-- of one, with this schema and the tag "favorite". A dedicated schema, rather
-- than a "favorite" tag in tags@1, so that tags anyone writes for other
-- reasons can't pass for favorites. Your favorites are
-- GET /annotations?schema=favorite@1&created_by=<you>; starring creates one
-- (private: access null), unstarring deletes it.
insert into annotation_schemas (name, version, kind, vector_dim, json_schema, description, created_by)
select 'favorite', 1, 'tags', null, null,
       'A favorite ("star"): a private annotation of a sound, or a segment of one, tagged "favorite"',
       u.id
from users u
where u.user_name = 'system';
