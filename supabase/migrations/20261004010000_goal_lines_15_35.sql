-- Mas/menos 1,5 y 3,5 goles. Prueba con temporadas anteriores (21.831
-- partidos): 1,5 casi perfectamente calibrado (k = 0,995); 3,5 algo
-- exagerado (k = 0,922). Se muestran, se congelan y se califican igual que 2,5.
insert into market_shrink (market, k, sample_n, note) values
  ('goles15', 0.995, 21831, 'Mas de 1,5: dijo 77,5 acerto 77,0 (75-80%)'),
  ('goles35', 0.922, 21831, 'Menos de 3,5: dijo 82,3 acerto 77,2 (80-85%)')
on conflict (market) do update set k = excluded.k, sample_n = excluded.sample_n, note = excluded.note, updated_at = now();

create or replace function public.soccer_total_over(lh numeric, la numeric, line numeric, rho numeric default -0.08)
returns numeric language sql immutable strict set search_path = public as $$
  with g as (
    select i, j,
      exp(-lh) * power(lh, i) / factorial(i) * exp(-la) * power(la, j) / factorial(j) *
      greatest(case when i = 0 and j = 0 then 1 - lh * la * rho
                    when i = 0 and j = 1 then 1 + lh * rho
                    when i = 1 and j = 0 then 1 + la * rho
                    when i = 1 and j = 1 then 1 - rho else 1 end, 0) p
    from generate_series(0, 10) i, generate_series(0, 10) j
  )
  select sum(p) filter (where i + j > line) / sum(p) from g
$$;

do $mig$
declare v text := pg_get_viewdef('forecast_board'::regclass, true);
begin
  if position('over15' in v) = 0 then
    v := replace(v, 'soccer_top_scores(m.lh, m.la) AS top_scores
   FROM f', 'soccer_top_scores(m.lh, m.la) AS top_scores,
    round(shrink_prob(soccer_total_over(m.lh, m.la, 1.5), ''goles15''::text), 4) AS over15,
    round(shrink_prob(soccer_total_over(m.lh, m.la, 3.5), ''goles35''::text), 4) AS over35
   FROM f');
    execute 'create or replace view forecast_board with (security_invoker = true) as ' || v;
  end if;
end $mig$;

alter table forecast_log add column if not exists over15 numeric;
alter table forecast_log add column if not exists over35 numeric;

create or replace function public.log_forecasts()
 returns integer language plpgsql security definer set search_path to 'public' as $function$
declare n int;
begin
  insert into forecast_log (fixture_id, sport, league, home_team, away_team, commence_time, source,
    p_home, p_draw, p_away, pick, pick_prob, confidence, over25, btts, top_home, top_away, dc_pick, dc_prob, over15, over35)
  select fixture_id, sport, league, home_team, away_team, commence_time, source,
    p_home, p_draw, p_away, pick, pick_prob, confidence, over25, btts, top_home, top_away, dc_pick, dc_prob, over15, over35
  from forecast_board
  where commence_time < now() + interval '3 hours'
  on conflict (fixture_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$function$;

do $mig$
declare v text := pg_get_viewdef('forecast_results'::regclass, true);
begin
  if position('hit_over15' in v) = 0 then
    v := replace(v, '   FROM forecast_log l', ',
    l.over15,
    l.over35,
        CASE
            WHEN l.over15 IS NULL THEN NULL::boolean
            ELSE (l.over15 >= 0.5) = ((f.home_score + f.away_score) > 1)
        END AS hit_over15,
        CASE
            WHEN l.over35 IS NULL THEN NULL::boolean
            ELSE (l.over35 >= 0.5) = ((f.home_score + f.away_score) > 3)
        END AS hit_over35
   FROM forecast_log l');
    execute 'create or replace view forecast_results with (security_invoker = true) as ' || v;
  end if;
end $mig$;
