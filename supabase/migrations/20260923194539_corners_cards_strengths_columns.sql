-- Extiende team_strengths y league_goal_baselines con fuerzas de
-- corners/tarjetas, mismo enfoque Poisson que ya usamos para goles
-- (ataque/defensa relativos al promedio de la liga). Solo se llenan para
-- las ligas que tienen la fuente football-data.co.uk (las unicas con este
-- dato hoy); en el resto quedan NULL y el modelo simplemente no se activa
-- ahi -- no se inventa un numero sin datos reales detras.
alter table team_strengths add column if not exists corner_attack numeric;
alter table team_strengths add column if not exists corner_defense numeric;
alter table team_strengths add column if not exists card_attack numeric;
alter table team_strengths add column if not exists card_defense numeric;

alter table league_goal_baselines add column if not exists avg_home_corners numeric;
alter table league_goal_baselines add column if not exists avg_away_corners numeric;
alter table league_goal_baselines add column if not exists avg_home_cards numeric;
alter table league_goal_baselines add column if not exists avg_away_cards numeric;
