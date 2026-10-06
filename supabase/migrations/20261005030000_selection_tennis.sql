-- La Seleccion del dia tambien toma tenis (ganador del partido) con 75 % o mas.
CREATE OR REPLACE FUNCTION public.publish_selection(p_max integer DEFAULT 5, p_min_prob numeric DEFAULT 0.75)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
-- Seleccion del dia: hasta 5 picks con la probabilidad mas alta.
-- Futbol: doble oportunidad / ganador (modelo + mercado), mas de 1,5, menos de 3,5 (>= p_min_prob).
-- Tenis: ganador del partido solo con 75 % o mas (la prueba en vivo mostro que de 70 % para arriba cumple).
declare d date := (now() at time zone 'America/Bogota')::date; n int;
begin
  if exists (select 1 from selection_picks where pick_date = d) then return 0; end if;
  with b as (
    select * from forecast_board
    where sport = 'soccer' and commence_time > now() + interval '30 minutes'
      and (commence_time at time zone 'America/Bogota')::date = d
  ), t as (
    select * from forecast_board
    where sport = 'tennis' and commence_time > now() + interval '30 minutes'
      and (commence_time at time zone 'America/Bogota')::date = d
  ), c as (
    select fixture_id, league, home_team, away_team, commence_time,
      case when dc_pick = '1X' then 'dc_1X' else 'dc_X2' end market,
      case when dc_pick = '1X' then home_team else away_team end || ' o empate' label, dc_prob prob
    from b where source = 'modelo + mercado' and dc_prob is not null
    union all
    select fixture_id, league, home_team, away_team, commence_time,
      case when pick = 'Local' then 'win_home' else 'win_away' end,
      'Gana ' || case when pick = 'Local' then home_team else away_team end, pick_prob
    from b where source = 'modelo + mercado' and pick in ('Local', 'Visitante')
    union all
    select fixture_id, league, home_team, away_team, commence_time, 'over15', 'Más de 1,5 goles', over15
    from b where over15 is not null
    union all
    select fixture_id, league, home_team, away_team, commence_time, 'under35', 'Menos de 3,5 goles', 1 - over35
    from b where over35 is not null
    union all
    select fixture_id, league, home_team, away_team, commence_time,
      case when pick = 'Local' then 'win_home' else 'win_away' end,
      'Gana ' || case when pick = 'Local' then home_team else away_team end || ' (tenis)', pick_prob
    from t where pick in ('Local', 'Visitante') and pick_prob >= greatest(p_min_prob, 0.75)
  ), best as (
    select distinct on (fixture_id) * from c where prob >= p_min_prob order by fixture_id, prob desc
  )
  insert into selection_picks (pick_date, fixture_id, rank, league, home_team, away_team, commence_time, market, label, prob, min_odds)
  select d, fixture_id, row_number() over (order by prob desc), league, home_team, away_team, commence_time,
    market, label, round(prob, 4), round(1.03 / prob, 2)
  from best order by prob desc limit p_max;
  get diagnostics n = row_count;
  return n;
end;
$function$;
