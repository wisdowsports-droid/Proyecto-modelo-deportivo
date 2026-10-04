-- Gratis del dia: 2 de doble oportunidad + 1 de mas de 1,5 goles (85 %+), sin repetir la Seleccion Pro.
set lock_timeout = '5s';
alter table free_picks add column if not exists market text not null default 'dc', add column if not exists label text;
alter table free_picks alter column dc_pick drop not null;
update free_picks set label = case when dc_pick = '1X' then home_team else away_team end || ' o empate' where label is null and market = 'dc';

create or replace view public.free_picks_results with (security_invoker = true) as
 select fp.pick_date, fp.fixture_id, fp.league, fp.home_team, fp.away_team, fp.commence_time, fp.dc_pick, fp.dc_prob, fp.published_at,
   f.status, f.home_score, f.away_score,
   case when f.status <> 'finished' or f.home_score is null then null::boolean
        when fp.market = 'over15' then f.home_score + f.away_score >= 2
        when fp.dc_pick = '1X' then f.home_score >= f.away_score
        else f.away_score >= f.home_score end as hit,
   fp.market, fp.label
 from free_picks fp join fixtures f on f.id = fp.fixture_id;

-- dc_prob guarda la probabilidad del pick, sea doble oportunidad o mas de 1,5.
create or replace function public.publish_free_picks(p_max integer default 3, p_min_prob numeric default 0.85)
returns integer language plpgsql security definer set search_path to 'public' as $fn$
declare d date := (now() at time zone 'America/Bogota')::date; n int;
begin
  if exists (select 1 from free_picks where pick_date = d) then return 0; end if;
  with b as (
    select * from forecast_board
    where sport = 'soccer' and commence_time > now() + interval '30 minutes'
      and (commence_time at time zone 'America/Bogota')::date = d
      and fixture_id not in (select fixture_id from selection_picks where pick_date = d)
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
$fn$;

-- la Seleccion Pro se publica primero para que los gratis no la repitan
select cron.alter_job((select jobid from cron.job where jobname = 'publish-selection-daily'), schedule := '0 11 * * *');
select cron.alter_job((select jobid from cron.job where jobname = 'publish-free-picks-daily'), schedule := '5 11 * * *');

CREATE OR REPLACE FUNCTION public.public_free_dashboard()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with today as (select (now() at time zone 'America/Bogota')::date d)
  select jsonb_build_object(
    'generated_at', now(),
    'free', jsonb_build_object(
      'picks', (select coalesce(jsonb_agg(jsonb_build_object('league', league, 'home_team', home_team, 'away_team', away_team,
                  'commence_time', commence_time, 'dc_pick', dc_pick, 'dc_prob', dc_prob, 'market', market, 'label', label, 'hit', hit, 'home_score', home_score, 'away_score', away_score)
                  order by commence_time), '[]') from free_picks_results, today where pick_date = today.d),
      'rec', (select jsonb_build_object('n', count(hit), 'h', count(*) filter (where hit)) from free_picks_results),
      'history', (select coalesce(jsonb_agg(to_jsonb(t) order by t.commence_time desc), '[]') from (
        select pick_date, league, home_team, away_team, commence_time, dc_pick, dc_prob, market, label, hit, home_score, away_score
        from free_picks_results where hit is not null order by commence_time desc limit 30) t),
      'hist', (select jsonb_build_object('n', count(*), 'hit', avg(h::int)) from (
                 select (case when p_home + p_draw >= p_draw + p_away then home_score >= away_score else away_score >= home_score end) h
                 from sim_forecasts where greatest(p_home + p_draw, p_draw + p_away) >= 0.85
                 union all
                 select (home_score + away_score >= 2) from sim_forecasts where shrink_prob(over15, 'goles15') >= 0.85) x)),
    'pro_record', jsonb_build_object(
      'selection', (select jsonb_build_object('n', count(hit), 'h', count(*) filter (where hit)) from selection_results),
      'live', (select jsonb_build_object('n', count(*), 'hit_result', count(*) filter (where hit_result),
                 'n_alta', count(*) filter (where confidence='alta'), 'h_alta', count(*) filter (where confidence='alta' and hit_result),
                 'n_media', count(*) filter (where confidence='media'), 'h_media', count(*) filter (where confidence='media' and hit_result),
                 'n_baja', count(*) filter (where confidence='baja'), 'h_baja', count(*) filter (where confidence='baja' and hit_result),
                 'n_dc', count(hit_dc), 'hit_dc', count(*) filter (where hit_dc),
                 'n_o15', count(hit_over15), 'hit_o15', count(*) filter (where hit_over15)) from forecast_results),
      'upcoming', (select count(*) from forecast_board)),
    'sim', jsonb_build_object(
      'sum', (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from (
        select confidence, count(*) n, avg(hit_result::int) hit_result, avg(pick_prob) prob_media, avg(hit_over25::int) hit_over,
          avg(hit_btts::int) hit_btts, avg(hit_score::int) hit_score, min(match_date) desde, max(match_date) hasta,
          avg(hit_cards::int) hit_cards, count(hit_cards) n_cards, avg(hit_corners::int) hit_corners, count(hit_corners) n_corners,
          avg(hit_over15::int) hit_o15, avg(hit_over35::int) hit_o35
        from sim_forecasts group by rollup(confidence)) t),
      'leagues', (select coalesce(jsonb_agg(to_jsonb(t) order by t.hit_result desc), '[]') from (
        select league, count(*) n, avg(hit_result::int) hit_result, avg(hit_over25::int) hit_over,
          count(*) filter (where confidence='alta') n_alta, avg(hit_result::int) filter (where confidence='alta') hit_alta
        from sim_forecasts group by league) t))
  );
$function$;
