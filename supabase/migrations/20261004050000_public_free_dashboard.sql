-- Pagina publica (Vercel): solo datos GRATIS.
-- 1) Cierra todo el acceso anonimo a tablas y funciones.
-- 2) Expone una sola funcion, public_free_dashboard(), con los picks gratis,
--    su historial, los totales del record y la prueba historica. Nada de picks Pro.

revoke select, insert, update, delete, truncate, references, trigger on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke select, insert, update, delete, truncate, references, trigger on tables from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.public_free_dashboard()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with today as (select (now() at time zone 'America/Bogota')::date d)
  select jsonb_build_object(
    'generated_at', now(),
    'free', jsonb_build_object(
      'picks', (select coalesce(jsonb_agg(jsonb_build_object('league', league, 'home_team', home_team, 'away_team', away_team,
                  'commence_time', commence_time, 'dc_pick', dc_pick, 'dc_prob', dc_prob, 'hit', hit, 'home_score', home_score, 'away_score', away_score)
                  order by commence_time), '[]') from free_picks_results, today where pick_date = today.d),
      'rec', (select jsonb_build_object('n', count(hit), 'h', count(*) filter (where hit)) from free_picks_results),
      'history', (select coalesce(jsonb_agg(to_jsonb(t) order by t.commence_time desc), '[]') from (
        select pick_date, league, home_team, away_team, commence_time, dc_pick, dc_prob, hit, home_score, away_score
        from free_picks_results where hit is not null order by commence_time desc limit 30) t),
      'hist', (select jsonb_build_object('n', count(*), 'hit', avg((case when p_home + p_draw >= p_draw + p_away then home_score >= away_score else away_score >= home_score end)::int))
               from sim_forecasts where greatest(p_home + p_draw, p_draw + p_away) >= 0.85)),
    'pro_record', jsonb_build_object(
      'selection', (select jsonb_build_object('n', count(hit), 'h', count(*) filter (where hit)) from selection_results),
      'live', (select jsonb_build_object('n', count(*), 'hit_result', count(*) filter (where hit_result),
                 'n_alta', count(*) filter (where confidence='alta'), 'h_alta', count(*) filter (where confidence='alta' and hit_result),
                 'n_media', count(*) filter (where confidence='media'), 'h_media', count(*) filter (where confidence='media' and hit_result),
                 'n_baja', count(*) filter (where confidence='baja'), 'h_baja', count(*) filter (where confidence='baja' and hit_result),
                 'n_dc', count(hit_dc), 'hit_dc', count(*) filter (where hit_dc),
                 'n_o15', count(hit_over15), 'hit_o15', count(*) filter (where hit_over15)) from forecast_results),
      'upcoming', (select count(*) from forecast_board)),
    'sim', jsonb_build_object(
      'sum', (select coalesce(jsonb_agg(to_jsonb(t)), '[]') from (
        select confidence, count(*) n, avg(hit_result::int) hit_result, avg(pick_prob) prob_media, avg(hit_over25::int) hit_over,
          avg(hit_btts::int) hit_btts, avg(hit_score::int) hit_score, min(match_date) desde, max(match_date) hasta,
          avg(hit_cards::int) hit_cards, count(hit_cards) n_cards, avg(hit_corners::int) hit_corners, count(hit_corners) n_corners,
          avg(hit_over15::int) hit_o15, avg(hit_over35::int) hit_o35
        from sim_forecasts group by rollup(confidence)) t),
      'leagues', (select coalesce(jsonb_agg(to_jsonb(t) order by t.hit_result desc), '[]') from (
        select league, count(*) n, avg(hit_result::int) hit_result, avg(hit_over25::int) hit_over,
          count(*) filter (where confidence='alta') n_alta, avg(hit_result::int) filter (where confidence='alta') hit_alta
        from sim_forecasts group by league) t))
  );
$function$;

revoke execute on function public.public_free_dashboard() from public;
grant execute on function public.public_free_dashboard() to anon, authenticated;
