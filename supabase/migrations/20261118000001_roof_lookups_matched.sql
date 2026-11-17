-- Satellite roof lookups, part two: the Roof lookup page in the field app looks up any address the
-- estimator types, and "Start an estimate here" makes an estimate from the address Google matched.
-- That estimate's areas then look the house up by its own street, city, state and ZIP, typed
-- differently from what was first typed on the page. So a finished lookup also keeps the match key
-- of the address Google matched (lib/roof addressKey of lookupAddress of the parsed address), and
-- the server finds a saved lookup of the same house by either key instead of paying Google again.
-- Lookups from the page have no estimate or area (both columns already allow null).

alter table roof_lookups add column if not exists matched_key text check (char_length(matched_key) <= 200);

-- A matched key belongs to an address lookup or a pin lookup alike; it is set only once the lookup is done.
alter table roof_lookups drop constraint if exists roof_lookups_matched_when_done;
alter table roof_lookups add constraint roof_lookups_matched_when_done check (matched_key is null or status = 'done');

create index if not exists roof_lookups_reuse_matched_idx on roof_lookups (matched_key, created_at desc) where status = 'done' and matched_key is not null;
-- The Roof lookup page's recent lookups: the newest finished ones (per person through RLS; the owner sees all).
create index if not exists roof_lookups_recent_idx on roof_lookups (created_at desc) where status = 'done';
