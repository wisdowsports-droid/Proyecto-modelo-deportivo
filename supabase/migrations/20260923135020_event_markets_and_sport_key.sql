-- Guarda la sport_key real de The Odds API por fixture (necesaria para pedir
-- mercados adicionales de UN evento puntual via /events/{id}/odds).
alter table fixtures add column if not exists odds_api_sport_key text;

-- Backfill para las ligas ya sincronizadas hoy (mismo whitelist de sync-fixtures/sync-results).
update fixtures set odds_api_sport_key = case league
  when 'EPL' then 'soccer_epl'
  when 'La Liga - España' then 'soccer_spain_la_liga'
  when 'Serie A - Italia' then 'soccer_italy_serie_a'
  when 'Bundesliga - Alemania' then 'soccer_germany_bundesliga'
  when 'Ligue 1 - Francia' then 'soccer_france_ligue_one'
  when 'UEFA Champions League' then 'soccer_uefa_champs_league'
  when 'UEFA Champions League Women' then 'soccer_uefa_champs_league_women'
  when 'MLS' then 'soccer_usa_mls'
  when 'CONMEBOL Libertadores' then 'soccer_conmebol_copa_libertadores'
  when 'CONMEBOL Sudamericana' then 'soccer_conmebol_copa_sudamericana'
  when 'NBA' then 'basketball_nba'
  when 'WNBA' then 'basketball_wnba'
  when 'NFL' then 'americanfootball_nfl'
  when 'MLB' then 'baseball_mlb'
  else odds_api_sport_key
end
where odds_api_sport_key is null and external_id like 'oddsapi_%';

-- Cache de mercados adicionales por evento (goles/totales, ambos anotan,
-- corners, tarjetas, goleadores, etc). Un fetch en vivo por clic del
-- usuario, no por cada corrida del cron -- así no se dispara la cuota.
create table if not exists event_markets (
  id bigint generated always as identity primary key,
  fixture_id bigint not null references fixtures(id) on delete cascade unique,
  markets jsonb not null default '{}'::jsonb,
  bookmakers_seen int not null default 0,
  status text not null default 'ok',
  error text,
  fetched_at timestamptz not null default now()
);

alter table event_markets enable row level security;

create policy "event_markets public read"
  on event_markets for select
  to anon, authenticated
  using (true);
