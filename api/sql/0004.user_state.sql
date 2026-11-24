-- A small, private, machine-readable JSON document per user: e.g. a bot's
-- feed cursor.  Kept in the database (rather than with the bot) so that
-- clearing data also clears bot state.  state_version backs ETag/If-Match,
-- so concurrent writers (two instances of a bot, or a bot racing a
-- clear-data) can't silently overwrite each other.
alter table users
    add column state jsonb not null default '{}'::jsonb check (jsonb_typeof(state) = 'object'),
    add column state_version bigint not null default 0,
    add column state_updated_at timestamptz;
