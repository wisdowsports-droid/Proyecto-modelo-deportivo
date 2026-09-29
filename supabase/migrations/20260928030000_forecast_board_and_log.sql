-- Pronosticador: una fila por partido proximo con probabilidades de
-- resultado, goles, ambos anotan, marcador probable, corners y tarjetas,
-- mas un registro que congela cada pronostico antes del partido para medir
-- aciertos de forma honesta.
--
-- Resultado (1X2): mezcla log-lineal modelo^0.3 * mercado^0.7. En el backtest
-- (7.134 partidos) la mezcla pronostico mejor que el modelo solo (log loss
-- 0.973 vs 0.990). Mercado = Pinnacle sin margen si existe, si no la cuota
-- guardada sin margen. Goles/ambos anotan/marcador/corners/tarjetas: modelo v2.

create or replace function soccer_forecast(lam_home numeric, lam_away numeric, rho numeric default -0.08)
returns table(home_win numeric, draw_prob numeric, away_win numeric, over25 numeric, btts numeric,
              top_home int, top_away int, top_prob numeric)
language plpgsql immutable as $$
declare
  i int; j int; k int;
  lh double precision := lam_home; la double precision := lam_away; r double precision := rho;
  pi_ double precision; pj double precision; p double precision; tau double precision; fact double precision;
  tot double precision := 0; h double precision := 0; d double precision := 0; a double precision := 0;
  o double precision := 0; b double precision := 0; best double precision := -1; bi int := 0; bj int := 0;
begin
  for i in 0..10 loop
    fact := 1; for k in 2..i loop fact := fact * k; end loop;
    pi_ := exp(-lh) * lh^i / fact;
    for j in 0..10 loop
      fact := 1; for k in 2..j loop fact := fact * k; end loop;
      pj := exp(-la) * la^j / fact;
      tau := case when i = 0 and j = 0 then 1 - lh * la * r when i = 0 and j = 1 then 1 + lh * r
                  when i = 1 and j = 0 then 1 + la * r when i = 1 and j = 1 then 1 - r else 1 end;
      p := pi_ * pj * greatest(tau, 0);
      tot := tot + p;
      if i > j then h := h + p; elsif i = j then d := d + p; else a := a + p; end if;
      if i + j > 2 then o := o + p; end if;
      if i > 0 and j > 0 then b := b + p; end if;
      if p > best then best := p; bi := i; bj := j; end if;
    end loop;
  end loop;
  return query select (h/tot)::numeric, (d/tot)::numeric, (a/tot)::numeric, (o/tot)::numeric, (b/tot)::numeric, bi, bj, (best/tot)::numeric;
end;
$$;

-- P(Poisson(lam) > line)
create or replace function poisson_over(lam numeric, line numeric)
returns numeric language plpgsql immutable as $$
declare k int; p double precision; cdf double precision := 0; l double precision := lam;
begin
  if lam is null or lam <= 0 then return null; end if;
  p := exp(-l);
  for k in 0..floor(line)::int loop
    if k > 0 then p := p * l / k; end if;
    cdf := cdf + p;
  end loop;
  return (1 - cdf)::numeric;
end;
$$;

create or replace view forecast_board with (security_invoker = true) as
with f as (
  select * from fixtures
  where status = 'scheduled' and commence_time > now() and commence_time < now() + interval '14 days'
),
mk as (
  -- probabilidad del mercado sin margen
  select f.id,
    coalesce(f.fair_home, (1/f.odds_home) / (1/f.odds_home + coalesce(1/f.odds_draw,0) + 1/f.odds_away)) q_home,
    case when f.fair_source = 'pinnacle' then f.fair_draw
         when f.odds_draw is not null then (1/f.odds_draw) / (1/f.odds_home + 1/f.odds_draw + 1/f.odds_away) end q_draw,
    coalesce(f.fair_away, (1/f.odds_away) / (1/f.odds_home + coalesce(1/f.odds_draw,0) + 1/f.odds_away)) q_away
  from f where (f.fair_home is not null) or (f.odds_home is not null and f.odds_away is not null)
),
soc as (
  select f.id,
    b.avg_home_goals * th.attack * ta.defense lh,
    b.avg_away_goals * ta.attack * th.defense la,
    b.avg_home_corners * th.corner_attack * ta.corner_defense + b.avg_away_corners * ta.corner_attack * th.corner_defense corners_exp,
    b.avg_home_cards * th.card_attack * ta.card_defense + b.avg_away_cards * ta.card_attack * th.card_defense cards_exp
  from f
  join league_goal_baselines b on b.league = f.league
  join team_strengths th on th.league = f.league and th.team = match_team_strength(f.league, f.home_team)
  join team_strengths ta on ta.league = f.league and ta.team = match_team_strength(f.league, f.away_team)
  where f.sport = 'soccer'
),
m as (
  select f.id,
    coalesce(sf.home_win, f.model_prob_home) m_home,
    coalesce(sf.draw_prob, f.model_prob_draw) m_draw,
    coalesce(sf.away_win, f.model_prob_away) m_away,
    sf.over25, sf.btts, sf.top_home, sf.top_away, sf.top_prob,
    soc.lh, soc.la, soc.corners_exp, soc.cards_exp
  from f
  left join soc on soc.id = f.id
  left join lateral soccer_forecast(soc.lh, soc.la) sf on soc.id is not null
),
bl as (
  select f.id,
    case when m.m_home is not null and mk.q_home is not null then 'modelo + mercado'
         when m.m_home is not null then 'modelo' when mk.q_home is not null then 'mercado' end source,
    case when m.m_home is not null and mk.q_home is not null then power(m.m_home, 0.3) * power(mk.q_home, 0.7) else coalesce(m.m_home, mk.q_home) end xh,
    case when f.sport <> 'soccer' then 0
         when m.m_draw is not null and mk.q_draw is not null then power(m.m_draw, 0.3) * power(mk.q_draw, 0.7) else coalesce(m.m_draw, mk.q_draw, 0) end xd,
    case when m.m_away is not null and mk.q_away is not null then power(m.m_away, 0.3) * power(mk.q_away, 0.7) else coalesce(m.m_away, mk.q_away) end xa
  from f left join m on m.id = f.id left join mk on mk.id = f.id
),
p as (
  select bl.id, bl.source, bl.xh / (bl.xh + bl.xd + bl.xa) p_home, case when bl.xd > 0 then bl.xd / (bl.xh + bl.xd + bl.xa) end p_draw, bl.xa / (bl.xh + bl.xd + bl.xa) p_away
  from bl where bl.xh is not null and bl.xa is not null
)
select f.id fixture_id, f.sport, f.league, f.home_team, f.away_team, f.commence_time,
  p.source, round(p.p_home, 4) p_home, round(p.p_draw, 4) p_draw, round(p.p_away, 4) p_away,
  case when p.p_home >= coalesce(p.p_draw, 0) and p.p_home >= p.p_away then 'Local'
       when p.p_away >= coalesce(p.p_draw, 0) then 'Visitante' else 'Empate' end pick,
  round(greatest(p.p_home, coalesce(p.p_draw, 0), p.p_away), 4) pick_prob,
  case when greatest(p.p_home, coalesce(p.p_draw, 0), p.p_away) >= 0.60 then 'alta'
       when greatest(p.p_home, coalesce(p.p_draw, 0), p.p_away) >= 0.45 then 'media' else 'baja' end confidence,
  round(m.lh, 2) exp_goals_home, round(m.la, 2) exp_goals_away,
  round(m.over25, 4) over25, round(m.btts, 4) btts,
  m.top_home, m.top_away, round(m.top_prob, 4) top_prob,
  round(m.corners_exp, 1) corners_exp, round(poisson_over(m.corners_exp, 9.5), 4) corners_over95,
  round(m.cards_exp, 1) cards_exp, round(poisson_over(m.cards_exp, 4.5), 4) cards_over45
from f join p on p.id = f.id left join m on m.id = f.id;

grant select on forecast_board to anon, authenticated;

-- Registro congelado: el pronostico tal como estaba antes del partido.
create table if not exists forecast_log (
  fixture_id bigint primary key references fixtures(id) on delete cascade,
  logged_at timestamptz not null default now(),
  sport text, league text, home_team text, away_team text, commence_time timestamptz,
  source text, p_home numeric, p_draw numeric, p_away numeric,
  pick text, pick_prob numeric, confidence text,
  over25 numeric, btts numeric, top_home int, top_away int
);
alter table forecast_log enable row level security;
create policy "forecast_log public read" on forecast_log for select to anon, authenticated using (true);

create or replace function log_forecasts()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into forecast_log (fixture_id, sport, league, home_team, away_team, commence_time, source,
    p_home, p_draw, p_away, pick, pick_prob, confidence, over25, btts, top_home, top_away)
  select fixture_id, sport, league, home_team, away_team, commence_time, source,
    p_home, p_draw, p_away, pick, pick_prob, confidence, over25, btts, top_home, top_away
  from forecast_board
  where commence_time < now() + interval '3 hours'
  on conflict (fixture_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function log_forecasts() from anon, authenticated, public;

-- Evaluacion: solo partidos terminados con marcador real.
create or replace view forecast_results with (security_invoker = true) as
select l.*, f.home_score, f.away_score,
  case when f.home_score > f.away_score then 'Local' when f.home_score < f.away_score then 'Visitante' else 'Empate' end actual,
  (l.pick = case when f.home_score > f.away_score then 'Local' when f.home_score < f.away_score then 'Visitante' else 'Empate' end) hit_result,
  case when l.over25 is null then null else ((l.over25 >= 0.5) = (f.home_score + f.away_score > 2)) end hit_over25,
  case when l.btts is null then null else ((l.btts >= 0.5) = (f.home_score > 0 and f.away_score > 0)) end hit_btts,
  case when l.top_home is null then null else (l.top_home = f.home_score and l.top_away = f.away_score) end hit_score
from forecast_log l join fixtures f on f.id = l.fixture_id
where f.status = 'finished' and f.home_score is not null and f.away_score is not null;

grant select on forecast_results to anon, authenticated;

select cron.schedule('log-forecasts-hourly', '10 * * * *', $$ select log_forecasts(); $$);

-- El dashboard ya no es un comparador de cuotas: se apaga la actualizacion
-- automatica del buscador (se puede volver a activar con cron.schedule).
select cron.unschedule('refresh-odds-before-kickoff');
