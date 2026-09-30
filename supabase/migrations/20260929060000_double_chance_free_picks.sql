-- Doble oportunidad (1X / X2) y "Pronosticos gratis del dia".
-- Prueba historica (21.829 partidos): doble oportunidad con probabilidad
-- 85%+ acerto 90,6% (~3 por dia). Se usa como gancho gratis.
--
-- 1) forecast_board: columnas dc_pick ('1X' | 'X2') y dc_prob al final.
do $mig$
declare v text := pg_get_viewdef('forecast_board'::regclass, true);
begin
  if position('dc_prob' in v) = 0 then
    v := replace(v, 'round(poisson_over(m.cards_exp, 4.5), 4) AS cards_over45
   FROM f', 'round(poisson_over(m.cards_exp, 4.5), 4) AS cards_over45,
        CASE
            WHEN p.p_draw IS NULL THEN NULL::text
            WHEN (p.p_home + p.p_draw) >= (p.p_draw + p.p_away) THEN ''1X''::text
            ELSE ''X2''::text
        END AS dc_pick,
        CASE
            WHEN p.p_draw IS NULL THEN NULL::numeric
            ELSE round(GREATEST(p.p_home + p.p_draw, p.p_draw + p.p_away), 4)
        END AS dc_prob
   FROM f');
    execute 'create or replace view forecast_board with (security_invoker = true) as ' || v;
  end if;
end $mig$;

-- 2) el registro congelado guarda tambien la doble oportunidad
alter table forecast_log add column if not exists dc_pick text;
alter table forecast_log add column if not exists dc_prob numeric;

create or replace function public.log_forecasts()
 returns integer language plpgsql security definer set search_path to 'public' as $function$
declare n int;
begin
  insert into forecast_log (fixture_id, sport, league, home_team, away_team, commence_time, source,
    p_home, p_draw, p_away, pick, pick_prob, confidence, over25, btts, top_home, top_away, dc_pick, dc_prob)
  select fixture_id, sport, league, home_team, away_team, commence_time, source,
    p_home, p_draw, p_away, pick, pick_prob, confidence, over25, btts, top_home, top_away, dc_pick, dc_prob
  from forecast_board
  where commence_time < now() + interval '3 hours'
  on conflict (fixture_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$function$;

-- 3) forecast_results: acierto de la doble oportunidad (columnas al final)
do $mig$
declare v text := pg_get_viewdef('forecast_results'::regclass, true);
begin
  if position('hit_dc' in v) = 0 then
    v := replace(v, '   FROM forecast_log l', ',
    l.dc_pick,
    l.dc_prob,
        CASE
            WHEN l.dc_pick = ''1X''::text THEN f.home_score >= f.away_score
            WHEN l.dc_pick = ''X2''::text THEN f.away_score >= f.home_score
            ELSE NULL::boolean
        END AS hit_dc
   FROM forecast_log l');
    execute 'create or replace view forecast_results with (security_invoker = true) as ' || v;
  end if;
end $mig$;

-- 4) Pronosticos gratis del dia: cada manana (6:00 a.m. Bogota) se eligen y
-- CONGELAN hasta 3 partidos de futbol del dia con doble oportunidad >= 85%,
-- solo con modelo + mercado (lo mas confiable). No se cambian despues.
create table if not exists free_picks (
  pick_date date not null,
  fixture_id bigint not null references fixtures(id),
  league text, home_team text, away_team text, commence_time timestamptz,
  dc_pick text not null, dc_prob numeric not null,
  published_at timestamptz not null default now(),
  primary key (pick_date, fixture_id)
);
alter table free_picks enable row level security;
drop policy if exists free_picks_read on free_picks;
create policy free_picks_read on free_picks for select using (true);

create or replace function public.publish_free_picks(p_max int default 3, p_min_prob numeric default 0.85)
 returns integer language plpgsql security definer set search_path to 'public' as $function$
declare d date := (now() at time zone 'America/Bogota')::date; n int;
begin
  if exists (select 1 from free_picks where pick_date = d) then return 0; end if;
  insert into free_picks (pick_date, fixture_id, league, home_team, away_team, commence_time, dc_pick, dc_prob)
  select d, fixture_id, league, home_team, away_team, commence_time, dc_pick, dc_prob
  from forecast_board
  where sport = 'soccer' and source = 'modelo + mercado' and dc_prob >= p_min_prob
    and commence_time > now() + interval '30 minutes'
    and (commence_time at time zone 'America/Bogota')::date = d
  order by dc_prob desc
  limit p_max;
  get diagnostics n = row_count;
  return n;
end;
$function$;

create or replace view free_picks_results with (security_invoker = true) as
select fp.*, f.status, f.home_score, f.away_score,
  case when f.status <> 'finished' or f.home_score is null then null
       when fp.dc_pick = '1X' then f.home_score >= f.away_score
       else f.away_score >= f.home_score end as hit
from free_picks fp join fixtures f on f.id = fp.fixture_id;

select cron.schedule('publish-free-picks-daily', '0 11 * * *', $cmd$ select publish_free_picks(); $cmd$);
