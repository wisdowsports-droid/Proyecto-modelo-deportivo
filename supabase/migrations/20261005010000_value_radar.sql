-- Radar de valor privado: mejor cuota vs cuota justa de Pinnacle (The Odds API, plan gratis).
create table if not exists public.value_radar (
  id bigserial primary key,
  fixture_id bigint, event_id text not null, sport_key text, league text,
  home_team text, away_team text, commence_time timestamptz,
  market text not null, selection text not null,
  fair_odds numeric, best_odds numeric, best_book text, edge numeric,
  first_seen timestamptz not null default now(), scanned_at timestamptz not null default now(),
  unique (event_id, market, selection)
);
create table if not exists public.radar_scans (
  id bigserial primary key, sport_key text, scanned_at timestamptz default now(),
  events int, with_pinnacle int, found int, credits int, remaining int
);
alter table public.value_radar enable row level security;
alter table public.radar_scans enable row level security;
revoke all on public.value_radar, public.radar_scans from anon, authenticated;

create or replace view public.value_radar_results as
select v.*, f.status, f.home_score, f.away_score,
  case when f.status <> 'finished' or f.home_score is null then null
       when v.market = '1X2' and v.selection = v.home_team then f.home_score > f.away_score
       when v.market = '1X2' and v.selection = v.away_team then f.away_score > f.home_score
       when v.market = '1X2' and v.selection = 'Draw' then f.home_score = f.away_score
       when v.market = 'Goles 2.5' and v.selection = 'Over' then f.home_score + f.away_score > 2
       when v.market = 'Goles 2.5' and v.selection = 'Under' then f.home_score + f.away_score < 3 end as hit
from value_radar v left join fixtures f on f.external_id = 'oddsapi_' || v.event_id;
revoke all on public.value_radar_results from anon, authenticated;

-- cada hora (la funcion decide si hay ligas con partidos en las proximas 3 h)
select cron.schedule('value-radar-hourly', '20 * * * *', $$
  select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/value-radar',
    headers := jsonb_build_object('Content-Type','application/json','apikey','<SUPABASE_ANON_KEY>','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := '{}'::jsonb, timeout_milliseconds := 60000);
$$);
