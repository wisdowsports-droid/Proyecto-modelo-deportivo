
-- Track which fixture a pick belongs to (reliable join for settlement,
-- instead of matching on the "event" text string) and whether it cleared
-- the value threshold when it was made (so "every forecast we made" and
-- "the ones we'd actually stake on" can both be reported without losing
-- either view).
alter table picks add column if not exists fixture_id bigint references fixtures(id);
alter table picks add column if not exists is_value boolean not null default false;

-- Backfill existing rows: match by exact event string + same calendar day
-- (best-effort, only source we have for pre-existing rows).
update picks p
set fixture_id = f.id
from fixtures f
where p.fixture_id is null
  and p.event = f.home_team || ' vs ' || f.away_team
  and p.event_date::date = f.commence_time::date;

update picks set is_value = true where edge is not null and edge >= 0.03 and is_value = false;

create index if not exists picks_fixture_id_idx on picks(fixture_id);
