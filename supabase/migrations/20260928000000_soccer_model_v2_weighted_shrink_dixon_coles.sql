-- Modelo de futbol v2 (validado con backtest walk-forward sobre ~7.100 partidos
-- de las 5 grandes ligas, 2022-2026: log loss 1X2 1.018 -> 0.990, temporada
-- en curso 1.228 -> 0.992). Cambios frente a v1:
--   1. Fuerzas ajustadas por rival (Poisson multiplicativo de Maher, iterativo)
--      en vez de promedios simples de goles.
--   2. Peso por antiguedad: vida media de 365 dias, ventana de 2 anos.
--   3. Encogimiento: 4 partidos "ficticios" de fuerza promedio por equipo, para
--      que 3 partidos no produzcan fuerzas extremas.
--   4. Recien ascendidos (ausentes la temporada anterior) arrancan con prior
--      ataque 0.85 / defensa 1.15.
--   5. Ajuste de marcadores bajos Dixon-Coles (rho = -0.08) en soccer_match_probs.
-- league_goal_baselines.avg_home_goals / avg_away_goals pasan a ser la base
-- multiplicativa del modelo (no el promedio crudo), asi la formula
-- lam = base * ataque * defensa que usan recompute_soccer_model_probs y
-- get-event-markets sigue igual.
-- Corners/tarjetas se mantienen con el metodo v1 (promedios simples).

create table if not exists team_strengths_backup_v1 as select * from team_strengths;
create table if not exists league_goal_baselines_backup_v1 as select * from league_goal_baselines;
alter table team_strengths_backup_v1 enable row level security;
alter table league_goal_baselines_backup_v1 enable row level security;

create or replace function refit_team_strengths_from_history(target_leagues text[], min_games int default 3)
returns int language plpgsql as $$
declare
  fresh_sources text[] := array['football-data.co.uk', 'football-data.org'];
  half_life constant double precision := 365;
  k constant double precision := 4;
  it int;
  updated_count int;
begin
  drop table if exists _g; drop table if exists _l; drop table if exists _t;

  create temp table _g on commit drop as
    select league, home_team h, away_team a, home_score::float8 hg, away_score::float8 ag, season,
           exp(-ln(2) * extract(epoch from (now() - match_date)) / 86400.0 / half_life) w
    from results_history
    where source = any(fresh_sources) and league = any(target_leagues)
      and match_date > now() - interval '730 days';

  create temp table _l on commit drop as
    select league,
           sum(w * hg) / sum(w) mh, sum(w * ag) / sum(w) ma,
           (sum(w * hg) + sum(w * ag)) / sum(w) / 2 m,
           max(season) cur_season
    from _g group by league;

  create temp table _t on commit drop as
    with cnt as (
      select league, team, count(*) n
      from (select league, h team from _g union all select league, a from _g) x group by 1, 2
    ),
    prevs as (
      select l.league, (select max(g.season) from _g g where g.league = l.league and g.season < l.cur_season) ps from _l l
    ),
    prevteams as (
      select distinct g.league, tm.team
      from _g g join prevs p on p.league = g.league and g.season = p.ps
      cross join lateral (values (g.h), (g.a)) tm(team)
    )
    select c.league, c.team, c.n,
           case when p.ps is not null and pt.team is null then 0.85 else 1.0 end::float8 pa,
           case when p.ps is not null and pt.team is null then 1.15 else 1.0 end::float8 pd,
           case when p.ps is not null and pt.team is null then 0.85 else 1.0 end::float8 att,
           case when p.ps is not null and pt.team is null then 1.15 else 1.0 end::float8 def
    from cnt c join prevs p on p.league = c.league
    left join prevteams pt on pt.league = c.league and pt.team = c.team;

  for it in 1..30 loop
    with s as (
      select league, team, sum(sc) s_, sum(ex) e_, sum(cc) c_, sum(fx) f_ from (
        select g.league, g.h team, g.w * g.hg sc, g.w * l.mh * ta.def ex, g.w * g.ag cc, g.w * l.ma * ta.att fx
        from _g g join _l l on l.league = g.league join _t ta on ta.league = g.league and ta.team = g.a
        union all
        select g.league, g.a, g.w * g.ag, g.w * l.ma * th.def, g.w * g.hg, g.w * l.mh * th.att
        from _g g join _l l on l.league = g.league join _t th on th.league = g.league and th.team = g.h
      ) x group by 1, 2
    )
    update _t t set
      att = (s.s_ + k * l.m * t.pa) / (s.e_ + k * l.m),
      def = (s.c_ + k * l.m * t.pd) / (s.f_ + k * l.m)
    from s join _l l on l.league = s.league
    where t.league = s.league and t.team = s.team;

    update _t t set att = t.att / n.a, def = t.def * n.a
    from (select league, avg(att) a from _t group by league) n where n.league = t.league;

    update _l l set mh = x.nh / x.dh, ma = x.na / x.da
    from (
      select g.league, sum(g.w * g.hg) nh, sum(g.w * th.att * ta.def) dh, sum(g.w * g.ag) na, sum(g.w * ta.att * th.def) da
      from _g g join _t th on th.league = g.league and th.team = g.h join _t ta on ta.league = g.league and ta.team = g.a
      group by g.league
    ) x where x.league = l.league;
  end loop;

  -- corners/tarjetas: metodo v1 (promedios simples relativos a la liga)
  with raw as (
    select league, home_corners, away_corners, coalesce(home_yellow,0)+coalesce(home_red,0) hk, coalesce(away_yellow,0)+coalesce(away_red,0) ak, home_team, away_team
    from results_history
    where source = any(fresh_sources) and league = any(target_leagues) and match_date > now() - interval '730 days'
  ),
  lb as (
    select league, avg(home_corners) hc, avg(away_corners) ac, (avg(home_corners)+avg(away_corners))/2.0 c_all,
           avg(hk) hk, avg(ak) ak, (avg(hk)+avg(ak))/2.0 k_all
    from raw group by league
  ),
  up_base as (
    insert into league_goal_baselines (league, avg_home_goals, avg_away_goals, avg_home_corners, avg_away_corners, avg_home_cards, avg_away_cards)
    select l.league, l.mh, l.ma, lb.hc, lb.ac, lb.hk, lb.ak from _l l left join lb on lb.league = l.league
    on conflict (league) do update set
      avg_home_goals = excluded.avg_home_goals, avg_away_goals = excluded.avg_away_goals,
      avg_home_corners = excluded.avg_home_corners, avg_away_corners = excluded.avg_away_corners,
      avg_home_cards = excluded.avg_home_cards, avg_away_cards = excluded.avg_away_cards,
      fitted_at = now()
    returning 1
  ),
  tm as (
    select league, home_team team, home_corners cf, away_corners ca, hk kf, ak ka from raw
    union all
    select league, away_team, away_corners, home_corners, ak, hk from raw
  ),
  tagg as (
    select tm.league, tm.team,
           avg(cf) / nullif(max(lb.c_all), 0) corner_attack, avg(ca) / nullif(max(lb.c_all), 0) corner_defense,
           avg(kf) / nullif(max(lb.k_all), 0) card_attack, avg(ka) / nullif(max(lb.k_all), 0) card_defense
    from tm join lb on lb.league = tm.league group by tm.league, tm.team
  ),
  up_teams as (
    insert into team_strengths (league, team, attack, defense, corner_attack, corner_defense, card_attack, card_defense)
    select t.league, t.team, t.att, t.def, a.corner_attack, a.corner_defense, a.card_attack, a.card_defense
    from _t t left join tagg a on a.league = t.league and a.team = t.team
    where t.n >= min_games
    on conflict (league, team) do update set
      attack = excluded.attack, defense = excluded.defense,
      corner_attack = excluded.corner_attack, corner_defense = excluded.corner_defense,
      card_attack = excluded.card_attack, card_defense = excluded.card_defense,
      fitted_at = now()
    returning 1
  )
  select (select count(*) from up_teams) + 0 * (select count(*) from up_base) into updated_count;

  return updated_count;
end;
$$;

drop function if exists soccer_match_probs(numeric, numeric, integer);
create function soccer_match_probs(lam_home numeric, lam_away numeric, max_goals int default 10, rho numeric default -0.08)
returns table(home_win numeric, draw_prob numeric, away_win numeric) language plpgsql immutable as $$
declare
  i int; j int; k int;
  p_i double precision; p_j double precision; p double precision; tau double precision;
  total double precision := 0;
  home_p double precision := 0; draw_p double precision := 0; away_p double precision := 0;
  fact double precision;
  lh double precision := lam_home; la double precision := lam_away; r double precision := rho;
begin
  for i in 0..max_goals loop
    fact := 1;
    for k in 2..i loop fact := fact * k; end loop;
    p_i := exp(-lh) * lh^i / fact;
    for j in 0..max_goals loop
      fact := 1;
      for k in 2..j loop fact := fact * k; end loop;
      p_j := exp(-la) * la^j / fact;
      tau := case
        when i = 0 and j = 0 then 1 - lh * la * r
        when i = 0 and j = 1 then 1 + lh * r
        when i = 1 and j = 0 then 1 + la * r
        when i = 1 and j = 1 then 1 - r
        else 1 end;
      p := p_i * p_j * greatest(tau, 0);
      total := total + p;
      if i > j then home_p := home_p + p;
      elsif i = j then draw_p := draw_p + p;
      else away_p := away_p + p;
      end if;
    end loop;
  end loop;
  return query select (home_p/total)::numeric, (draw_p/total)::numeric, (away_p/total)::numeric;
end;
$$;
