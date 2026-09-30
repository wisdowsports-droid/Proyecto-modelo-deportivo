-- Simulacion con temporadas pasadas (funcion simulate-history): cada partido
-- pronosticado solo con datos anteriores a el (walk-forward) y comparado con
-- el resultado real. Se muestra en el dashboard separado de los resultados
-- reales (forecast_log). Se llena con una llamada por liga:
--   {"league":"E0"}, {"league":"new:BRA"}, ...
create table if not exists sim_forecasts (
  id bigserial primary key,
  league text not null,
  season text,
  match_date date not null,
  home_team text not null,
  away_team text not null,
  source text not null,
  p_home numeric, p_draw numeric, p_away numeric,
  pick text, pick_prob numeric, confidence text,
  over25 numeric, btts numeric, top_home int, top_away int,
  home_score int not null, away_score int not null,
  hit_result boolean, hit_over25 boolean, hit_btts boolean, hit_score boolean,
  created_at timestamptz not null default now(),
  unique (league, match_date, home_team, away_team)
);
alter table sim_forecasts enable row level security;
drop policy if exists sim_forecasts_read on sim_forecasts;
create policy sim_forecasts_read on sim_forecasts for select using (true);
comment on table sim_forecasts is 'Simulacion con temporadas pasadas: cada partido pronosticado solo con datos anteriores a el (walk-forward). Separado de forecast_log (resultados reales).';
