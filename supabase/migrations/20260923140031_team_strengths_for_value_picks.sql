-- Fuerzas de ataque/defensa por equipo (modelo Poisson ya construido en
-- picks_engine) + promedios de gol por liga. Se usan para calcular en vivo,
-- dentro del edge function get-event-markets, las probabilidades de
-- goles totales y ambos anotan -- y compararlas contra las cuotas reales
-- para detectar valor, igual que ya hacemos con 1X2.
create table if not exists team_strengths (
  league text not null,
  team text not null,
  attack numeric not null,
  defense numeric not null,
  fitted_at timestamptz not null default now(),
  primary key (league, team)
);

create table if not exists league_goal_baselines (
  league text primary key,
  avg_home_goals numeric not null,
  avg_away_goals numeric not null,
  fitted_at timestamptz not null default now()
);

alter table team_strengths enable row level security;
alter table league_goal_baselines enable row level security;
create policy "team_strengths public read" on team_strengths for select to anon, authenticated using (true);
create policy "league_goal_baselines public read" on league_goal_baselines for select to anon, authenticated using (true);
