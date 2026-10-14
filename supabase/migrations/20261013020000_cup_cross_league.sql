-- Copas (Champions, Libertadores, Sudamericana): goles, corners y tarjetas a partir de las ligas locales de cada equipo.
-- Validado con 342 partidos de copa jugados: goles esperados 2,77 vs 2,73 reales; Menos de 3,5 con 75 %+ acierta 85 %.
-- No se usa para el ganador (en la prueba solo acertaba 49 %): en copas el 1X2 sigue saliendo del mercado.
-- (Ya aplicado en Supabase; este archivo deja constancia en el repo.)

create or replace function public.league_region(p_league text) returns text language sql immutable as $$
  select case when p_league in ('Primera División - Argentina','Brazil Série A','Primera División - Chile','Liga BetPlay (Colombia Primera A)',
                                'LigaPro - Ecuador','Primera División - Paraguay','Liga 1 - Peru','Primera División - Uruguay',
                                'Copa Libertadores','Copa Sudamericana') then 'sa'
              when p_league in ('MLS','Liga MX','J1 League - Japan') then 'otro'
              else 'eu' end $$;

create table if not exists public.team_home_league (
  team_name text not null, region text not null, league text, team text, primary key (team_name, region));
alter table public.team_home_league enable row level security;
revoke all on public.team_home_league from anon, authenticated;

create or replace function public.find_home_league(p_team text, p_region text) returns table(league text, team text)
language plpgsql stable set search_path to 'public' as $$
declare lg text; t text;
begin
  for lg in select distinct s.league from team_strengths s
            where s.league not in ('UEFA Champions League','UEFA Champions League Women','UEFA Nations League','Copa Libertadores','Copa Sudamericana')
              and league_region(s.league) = p_region order by 1
  loop
    t := match_team_strength(lg, p_team);
    if t is not null then league := lg; team := t; return next; return; end if;
  end loop;
end $$;

create or replace function public.cup_cross_forecast(p_home text, p_away text, p_region text)
returns table(home_league text, away_league text, lh numeric, la numeric, corners_exp numeric, cards_exp numeric)
language sql stable set search_path to 'public' as $$
  with r as (
    select m.team_name, m.league, b.g*s.attack gf, b.g*s.defense ga, b.c*s.corner_attack cf, b.c*s.corner_defense ca,
           b.k*s.card_attack kf, b.k*s.card_defense ka, b.g bg, b.c bc, b.k bk, sqrt(nullif(b.hg,0)/nullif(b.ag,0)) hadv
    from team_home_league m join team_strengths s on s.league=m.league and s.team=m.team
    join lateral (select (lb.avg_home_goals+lb.avg_away_goals)/2 g, (lb.avg_home_corners+lb.avg_away_corners)/2 c,
                         (lb.avg_home_cards+lb.avg_away_cards)/2 k, lb.avg_home_goals hg, lb.avg_away_goals ag
                  from league_goal_baselines lb where lb.league = m.league) b on true
    where m.region = p_region and m.team_name in (p_home, p_away))
  select h.league, a.league,
    h.gf * a.ga / ((h.bg + a.bg)/2) * coalesce(h.hadv, 1.1),
    a.gf * h.ga / ((h.bg + a.bg)/2) / coalesce(h.hadv, 1.1),
    case when h.cf is not null and a.cf is not null then (h.cf * a.ca + a.cf * h.ca) / ((h.bc + a.bc)/2) end,
    case when h.kf is not null and a.kf is not null then (h.kf * a.ka + a.kf * h.ka) / ((h.bk + a.bk)/2) end
  from r h, r a where h.team_name = p_home and a.team_name = p_away
$$;

-- forecast_board: en el CTE "soc" las copas usan cup_cross_forecast (columna xcup = true),
-- y en el CTE "m" el 1X2 de esas filas sale de fixtures.model_prob_* (no del modelo de goles).
-- Cron diario 'cup-home-league-daily' (10:50 UTC) llena team_home_league con los equipos nuevos de copa.
