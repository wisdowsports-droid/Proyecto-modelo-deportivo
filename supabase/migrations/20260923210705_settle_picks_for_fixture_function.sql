
-- Auto-settlement for the markets we can grade purely from the final score
-- (goals totals, both-teams-to-score, double chance). Corners/cards picks
-- are deliberately left untouched here -- fixtures has no column for the
-- actual final corner/card count, so there's nothing to grade them
-- against yet; they stay "pending" until that data source exists.
create or replace function settle_picks_for_fixture(p_fixture_id bigint)
returns int
language plpgsql
as $$
declare
  fx record;
  pk record;
  total_goals int;
  home_win boolean;
  away_win boolean;
  is_draw boolean;
  line numeric;
  new_status text;
  settled_count int := 0;
begin
  select id, home_team, away_team, home_score, away_score, status
  into fx
  from fixtures
  where id = p_fixture_id;

  if fx.id is null or fx.status <> 'finished' or fx.home_score is null or fx.away_score is null then
    return 0;
  end if;

  total_goals := fx.home_score + fx.away_score;
  home_win := fx.home_score > fx.away_score;
  away_win := fx.away_score > fx.home_score;
  is_draw := fx.home_score = fx.away_score;

  for pk in select * from picks where fixture_id = p_fixture_id and status = 'pending' loop
    new_status := null;

    if pk.market ilike 'Goles totales%' then
      line := regexp_replace(pk.market, '^Goles totales\s+', '')::numeric;
      if total_goals > line then
        new_status := case when pk.selection ilike 'Over%' then 'won' else 'lost' end;
      elsif total_goals < line then
        new_status := case when pk.selection ilike 'Under%' then 'won' else 'lost' end;
      else
        new_status := 'push';
      end if;

    elsif pk.market = 'Ambos anotan' then
      if fx.home_score > 0 and fx.away_score > 0 then
        new_status := case when pk.selection = 'Sí' then 'won' else 'lost' end;
      else
        new_status := case when pk.selection = 'No' then 'won' else 'lost' end;
      end if;

    elsif pk.market = 'Doble oportunidad' then
      if pk.selection ilike '1X%' then
        new_status := case when home_win or is_draw then 'won' else 'lost' end;
      elsif pk.selection ilike 'X2%' then
        new_status := case when is_draw or away_win then 'won' else 'lost' end;
      elsif pk.selection ilike '12%' then
        new_status := case when not is_draw then 'won' else 'lost' end;
      end if;
    end if;

    if new_status is not null then
      update picks set
        status = new_status,
        result_note = 'Final ' || fx.home_score || '-' || fx.away_score || ' (' || fx.home_team || ' vs ' || fx.away_team || ')',
        settled_at = now()
      where id = pk.id;
      settled_count := settled_count + 1;
    end if;
  end loop;

  return settled_count;
end;
$$;

-- Fire automatically the moment a fixture flips to finished with a real
-- score, from ANY path that does it (sync-results-daily, a manual
-- UPDATE, whatever) -- so this stops being something Claude has to
-- remember to run by hand.
create or replace function trg_settle_picks_on_fixture_finish()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'finished' and new.home_score is not null and new.away_score is not null
     and (old.status is distinct from new.status or old.home_score is distinct from new.home_score or old.away_score is distinct from new.away_score) then
    perform settle_picks_for_fixture(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists settle_picks_on_fixture_finish on fixtures;
create trigger settle_picks_on_fixture_finish
  after update on fixtures
  for each row
  execute function trg_settle_picks_on_fixture_finish();
