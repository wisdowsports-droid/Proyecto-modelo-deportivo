-- Gratis del dia = los 3 picks de mayor probabilidad de la Seleccion Pro (75 %+, cualquier mercado).
-- Si ese dia no hay Seleccion, se usa la regla anterior (doble oportunidad / mas de 1,5 al 85 %+).
create or replace function public.publish_free_picks(p_max integer default 3, p_min_prob numeric default 0.85)
returns integer language plpgsql security definer set search_path to 'public' as $function$
declare d date := (now() at time zone 'America/Bogota')::date; n int;
begin
  if exists (select 1 from free_picks where pick_date = d) then return 0; end if;
  insert into free_picks (pick_date, fixture_id, league, home_team, away_team, commence_time, dc_pick, dc_prob, market, label)
  select d, s.fixture_id, s.league, s.home_team, s.away_team, s.commence_time,
    case s.market when 'dc_1X' then '1X' when 'dc_X2' then 'X2' else null end, s.prob, s.market, s.label
  from selection_picks s
  where s.pick_date = d and s.void_reason is null and s.commence_time > now() + interval '30 minutes'
  order by s.prob desc, s.rank limit p_max;
  get diagnostics n = row_count;
  if n > 0 then return n; end if;

  with b as (
    select * from forecast_board
    where sport = 'soccer' and commence_time > now() + interval '30 minutes'
      and (commence_time at time zone 'America/Bogota')::date = d
  ), o15 as (
    select fixture_id, league, home_team, away_team, commence_time, null::text dc_pick, round(over15, 4) prob, 'over15' market, 'Más de 1,5 goles' label
    from b where over15 >= p_min_prob order by over15 desc limit 1
  ), dc as (
    select fixture_id, league, home_team, away_team, commence_time, dc_pick, dc_prob prob, 'dc' market,
           case when dc_pick = '1X' then home_team else away_team end || ' o empate' label
    from b where source = 'modelo + mercado' and dc_prob >= p_min_prob
      and fixture_id not in (select fixture_id from o15)
    order by dc_prob desc limit greatest(p_max - (select count(*) from o15), 0)
  )
  insert into free_picks (pick_date, fixture_id, league, home_team, away_team, commence_time, dc_pick, dc_prob, market, label)
  select d, fixture_id, league, home_team, away_team, commence_time, dc_pick, prob, market, label from o15
  union all
  select d, fixture_id, league, home_team, away_team, commence_time, dc_pick, prob, market, label from dc;
  get diagnostics n = row_count;
  return n;
end;
$function$;

-- calificacion: tambien los mercados que vienen de la Seleccion
create or replace view public.free_picks_results as
select fp.pick_date, fp.fixture_id, fp.league, fp.home_team, fp.away_team, fp.commence_time, fp.dc_pick, fp.dc_prob, fp.published_at,
  f.status, f.home_score, f.away_score,
  case
    when f.status <> 'finished' or f.home_score is null then null::boolean
    when fp.market = 'over15' then f.home_score + f.away_score >= 2
    when fp.market = 'under35' then f.home_score + f.away_score <= 3
    when fp.market = 'win_home' then f.home_score > f.away_score
    when fp.market = 'win_away' then f.away_score > f.home_score
    when fp.market = 'dc_1X' or fp.dc_pick = '1X' then f.home_score >= f.away_score
    when fp.market = 'dc_X2' or fp.dc_pick = 'X2' then f.away_score >= f.home_score
    else null::boolean
  end as hit,
  fp.market, fp.label
from free_picks fp join fixtures f on f.id = fp.fixture_id;
