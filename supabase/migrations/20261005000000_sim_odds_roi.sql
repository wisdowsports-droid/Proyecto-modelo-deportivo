-- Cuotas historicas de los partidos simulados, para medir rentabilidad (ROI).
-- La llena la funcion load-sim-odds (football-data.co.uk).
create table if not exists public.sim_odds (
  league text not null, match_date date not null, home_team text not null, away_team text not null,
  avg_h numeric, avg_d numeric, avg_a numeric,       -- promedio previo al partido
  max_h numeric, max_d numeric, max_a numeric,       -- mejor cuota previa
  cl_h numeric, cl_d numeric, cl_a numeric,          -- promedio de cierre
  avg_o25 numeric, avg_u25 numeric, max_o25 numeric, max_u25 numeric, cl_o25 numeric, cl_u25 numeric,
  primary key (league, match_date, home_team, away_team)
);
alter table public.sim_odds enable row level security;
revoke all on public.sim_odds from anon, authenticated;

create or replace view public.sim_bets as
select s.league, s.season, s.match_date, s.home_team, s.away_team, s.source, s.confidence,
  s.p_home, s.p_draw, s.p_away, s.pick, s.pick_prob, s.over25, s.home_score, s.away_score,
  o.avg_h, o.avg_d, o.avg_a, o.max_h, o.max_d, o.max_a, o.cl_h, o.cl_d, o.cl_a,
  o.avg_o25, o.avg_u25, o.max_o25, o.max_u25, o.cl_o25, o.cl_u25
from sim_forecasts s join sim_odds o on o.league = s.league and o.match_date = s.match_date and o.home_team = s.home_team and o.away_team = s.away_team;
revoke all on public.sim_bets from anon, authenticated;

-- Cuotas de Pinnacle, Bet365, maximas de cierre y marcador (para la estrategia "mejor cuota vs Pinnacle")
alter table public.sim_odds
  add column if not exists hg int, add column if not exists ag int,
  add column if not exists ps_h numeric, add column if not exists ps_d numeric, add column if not exists ps_a numeric,
  add column if not exists psc_h numeric, add column if not exists psc_d numeric, add column if not exists psc_a numeric,
  add column if not exists b365_h numeric, add column if not exists b365_d numeric, add column if not exists b365_a numeric,
  add column if not exists maxc_h numeric, add column if not exists maxc_d numeric, add column if not exists maxc_a numeric,
  add column if not exists ps_o25 numeric, add column if not exists ps_u25 numeric,
  add column if not exists psc_o25 numeric, add column if not exists psc_u25 numeric,
  add column if not exists maxc_o25 numeric, add column if not exists maxc_u25 numeric;

-- fair_* = cuota justa de Pinnacle sin margen (metodo multiplicativo)
create or replace view public.pin_bets as
with base as (
  select o.*, 1/ps_h+1/ps_d+1/ps_a ov_pre, 1/psc_h+1/psc_d+1/psc_a ov_cl,
    1/ps_o25+1/ps_u25 ovou_pre, 1/psc_o25+1/psc_u25 ovou_cl from sim_odds o where hg is not null)
select b.league, b.match_date, extract(year from b.match_date) yr, x.mkt, x.sel, x.won,
  x.fair_pre, x.fair_cl, x.max_pre, x.b365, x.max_cl
from base b cross join lateral (values
  ('1X2','H', b.hg>b.ag, b.ps_h*b.ov_pre, b.psc_h*b.ov_cl, b.max_h, b.b365_h, b.maxc_h),
  ('1X2','D', b.hg=b.ag, b.ps_d*b.ov_pre, b.psc_d*b.ov_cl, b.max_d, b.b365_d, b.maxc_d),
  ('1X2','A', b.hg<b.ag, b.ps_a*b.ov_pre, b.psc_a*b.ov_cl, b.max_a, b.b365_a, b.maxc_a),
  ('OU','O', b.hg+b.ag>2, b.ps_o25*b.ovou_pre, b.psc_o25*b.ovou_cl, b.max_o25, null::numeric, b.maxc_o25),
  ('OU','U', b.hg+b.ag<3, b.ps_u25*b.ovou_pre, b.psc_u25*b.ovou_cl, b.max_u25, null::numeric, b.maxc_u25)
) x(mkt, sel, won, fair_pre, fair_cl, max_pre, b365, max_cl);
revoke all on public.pin_bets from anon, authenticated;
