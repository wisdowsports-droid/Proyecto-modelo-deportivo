-- API-Football (plan gratis): bajas, alineaciones, estadisticas y prediccion de referencia
-- para los partidos que ya tenemos. La funcion api-football-sync llena apif_fixtures cada 15 min.
create table if not exists public.apif_fixtures (
  apif_id bigint primary key,
  fixture_id bigint references public.fixtures(id) on delete set null,
  league_id int, league text, country text, kickoff timestamptz, home text, away text,
  status text, home_goals int, away_goals int,
  pred_home numeric, pred_draw numeric, pred_away numeric, pred_advice text, pred_under_over text, pred_at timestamptz,
  injuries jsonb, injuries_at timestamptz,
  lineups jsonb, lineups_at timestamptz, lineups_tries int default 0,
  stats jsonb, stats_at timestamptz, stats_tries int default 0,
  updated_at timestamptz default now()
);
create index if not exists apif_fixtures_fixture_idx on public.apif_fixtures(fixture_id);
create index if not exists apif_fixtures_kickoff_idx on public.apif_fixtures(kickoff);
create table if not exists public.apif_usage (day date primary key, calls int not null default 0, meta jsonb not null default '{}');
alter table public.apif_fixtures enable row level security;
alter table public.apif_usage enable row level security;
revoke all on public.apif_fixtures, public.apif_usage from anon, authenticated;

select cron.schedule('api-football-sync', '2,17,32,47 * * * *', $cron$
  with k as (select substring(command from '''(eyJ[^'']+)''') v from cron.job where jobname='backfill-espn-stats-daily')
  select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/api-football-sync',
    headers := jsonb_build_object('Content-Type','application/json','apikey',k.v,'Authorization','Bearer '||k.v),
    body := '{}'::jsonb, timeout_milliseconds := 120000) from k;
$cron$);

-- Nuestro modelo contra la prediccion de API-Football en los mismos partidos (ganador 1X2).
create or replace view public.apif_benchmark as
select f.id fixture_id, f.league, f.home_team, f.away_team, f.commence_time, f.home_score, f.away_score,
  case when f.home_score > f.away_score then 'H' when f.home_score < f.away_score then 'A' else 'D' end res,
  r.p_home, r.p_draw, r.p_away, a.pred_home, a.pred_draw, a.pred_away,
  case when r.p_home >= greatest(r.p_draw, r.p_away) then 'H' when r.p_away >= r.p_draw then 'A' else 'D' end our_pick,
  case when a.pred_home >= greatest(a.pred_draw, a.pred_away) then 'H' when a.pred_away >= a.pred_draw then 'A' else 'D' end apif_pick
from apif_fixtures a
join fixtures f on f.id = a.fixture_id
join forecast_results r on r.fixture_id = f.id
where a.pred_home is not null and f.home_score is not null and r.p_home is not null;
revoke all on public.apif_benchmark from anon, authenticated;

-- Parrilla del dueno: agrega bajas, alineaciones y la prediccion de API-Football por partido.
create or replace function public.owner_board(p_key text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  with ok as (select 1 from app_settings where key='owner_key' and value = p_key and length(coalesce(p_key,''))>=32)
  select case when exists(select 1 from ok) then jsonb_build_object(
    'upcoming', (select coalesce(jsonb_agg(to_jsonb(t) order by t.commence_time), '[]') from (
       select b.sport, b.league, b.home_team, b.away_team, b.commence_time, b.source, b.pick, b.pick_prob, b.confidence,
         b.p_home, b.p_draw, b.p_away, b.dc_pick, b.dc_prob, b.over15, b.over25, b.over35, b.btts, b.top_home, b.top_away, b.top_prob,
         b.corners_exp, b.corners_over95, b.cards_exp, b.cards_over45,
         case when a.apif_id is null then null else jsonb_build_object(
           'injuries', a.injuries, 'lineups', a.lineups,
           'pred', case when a.pred_home is null then null else jsonb_build_array(a.pred_home, a.pred_draw, a.pred_away) end,
           'advice', a.pred_advice) end apif
       from forecast_board b
       left join lateral (select * from apif_fixtures x where x.fixture_id = b.fixture_id limit 1) a on true
       where b.commence_time > now() - interval '2 hours'
         and b.commence_time < now() + case when b.sport = 'soccer' then interval '3 days' else interval '7 days' end
       order by b.commence_time limit 250) t),
    'recent', (select coalesce(jsonb_agg(to_jsonb(t) order by t.commence_time desc), '[]') from (
       select sport, league, home_team, away_team, commence_time, pick, pick_prob, confidence, home_score, away_score,
         hit_result, dc_pick, dc_prob, hit_dc, over15, hit_over15, over25, hit_over25, btts, hit_btts
       from forecast_results where commence_time > now() - interval '48 hours' and home_score is not null
       order by commence_time desc limit 150) t),
    'bysport', (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from (
       select sport, count(*) n, count(*) filter (where hit_result) h,
         count(*) filter (where confidence='alta') n_alta, count(*) filter (where confidence='alta' and hit_result) h_alta
       from forecast_results group by sport) t),
    'vs_apif', (select jsonb_build_object('n', count(*), 'ours', count(*) filter (where our_pick = res),
       'theirs', count(*) filter (where apif_pick = res)) from apif_benchmark))
  else null end;
$$;
revoke execute on function public.owner_board(text) from public;
grant execute on function public.owner_board(text) to anon, authenticated;
