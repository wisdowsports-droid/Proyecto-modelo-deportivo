-- Ajuste de probabilidades de goles, ambos anotan, corners y tarjetas segun
-- la prueba con temporadas anteriores (simulate-history, sim_forecasts).
-- El modelo exageraba su seguridad en estos mercados (va sin mercado): p.ej.
-- goles "74%" acertaba 68%, corners "76%" acertaba 58%. Se acerca cada
-- probabilidad a 50% con un factor k ajustado por minimos cuadrados:
--   p_ajustada = 0.5 + k * (p - 0.5)
-- Ademas: los 3 marcadores mas probables (antes solo uno, casi siempre 1-1).
create table if not exists market_shrink (
  market text primary key,
  k numeric not null,
  sample_n int,
  note text,
  updated_at timestamptz not null default now()
);
alter table market_shrink enable row level security;
drop policy if exists market_shrink_read on market_shrink;
create policy market_shrink_read on market_shrink for select using (true);

insert into market_shrink (market, k, sample_n, note) values
  ('goles',    0.682, 21829, '70%+ decia 74,2 acerto 68,0'),
  ('btts',     0.685, 21829, '70%+ decia 72,7 acerto 63,7'),
  ('corners',  0.420, 12902, '70%+ decia 76,3 acerto 58,5'),
  ('tarjetas', 0.705, 12902, '70%+ decia 77,3 acerto 68,7')
on conflict (market) do update set k = excluded.k, sample_n = excluded.sample_n, note = excluded.note, updated_at = now();

create or replace function public.shrink_prob(p numeric, p_market text) returns numeric
language sql stable set search_path = public as $$
  select case when p is null then null
    else 0.5 + coalesce((select k from market_shrink where market = p_market), 1) * (p - 0.5) end
$$;

create or replace function public.soccer_top_scores(lh numeric, la numeric, rho numeric default -0.08, n int default 3)
returns jsonb language sql immutable strict set search_path = public as $$
  with g as (
    select i, j,
      exp(-lh) * power(lh, i) / factorial(i) * exp(-la) * power(la, j) / factorial(j) *
      greatest(case when i = 0 and j = 0 then 1 - lh * la * rho
                    when i = 0 and j = 1 then 1 + lh * rho
                    when i = 1 and j = 0 then 1 + la * rho
                    when i = 1 and j = 1 then 1 - rho else 1 end, 0) p
    from generate_series(0, 8) i, generate_series(0, 8) j
  ), t as (select sum(p) s from g)
  select jsonb_agg(jsonb_build_object('h', i, 'a', j, 'p', round(p / s, 4)) order by p desc)
  from (select i, j, p from g order by p desc limit n) x, t
$$;

do $mig$
declare v text := pg_get_viewdef('forecast_board'::regclass, true);
begin
  if position('shrink_prob' in v) = 0 then
    v := replace(v, 'round(calibrate_prob(m.over25, mc.over25_shift), 4) AS over25',
                    'round(calibrate_prob(shrink_prob(m.over25, ''goles''::text), mc.over25_shift), 4) AS over25');
    v := replace(v, 'round(calibrate_prob(m.btts, mc.btts_shift), 4) AS btts',
                    'round(calibrate_prob(shrink_prob(m.btts, ''btts''::text), mc.btts_shift), 4) AS btts');
    v := replace(v, 'round(poisson_over(m.corners_exp, 9.5), 4) AS corners_over95',
                    'round(shrink_prob(poisson_over(m.corners_exp, 9.5), ''corners''::text), 4) AS corners_over95');
    v := replace(v, 'round(poisson_over(m.cards_exp, 4.5), 4) AS cards_over45',
                    'round(shrink_prob(poisson_over(m.cards_exp, 4.5), ''tarjetas''::text), 4) AS cards_over45');
    v := replace(v, 'END AS dc_prob
   FROM f', 'END AS dc_prob,
    soccer_top_scores(m.lh, m.la) AS top_scores
   FROM f');
    execute 'create or replace view forecast_board with (security_invoker = true) as ' || v;
  end if;
end $mig$;
