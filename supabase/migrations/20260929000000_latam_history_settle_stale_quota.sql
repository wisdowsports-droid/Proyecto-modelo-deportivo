-- Puntos 1-3 del diagnostico.
-- 1) Argentina, Brasil, Mexico y MLS: historial desde football-data.co.uk
--    (funcion sync-history-football-data-new) y calificacion gratuita de
--    partidos ya jugados cruzando fixtures con results_history.
-- 2) Contador de creditos real (funcion check-quota, gratis).
-- 3) Partidos que siguen 'scheduled' 4+ dias despues de su hora -> 'postponed'.
-- Reemplaza <SUPABASE_ANON_KEY> por la anon key del proyecto al aplicar.

create or replace function public.settle_fixtures_from_history(target_leagues text[])
 returns integer language plpgsql as $function$
declare n int;
begin
  with c as (
    select f.id, r.home_score, r.away_score, count(*) over (partition by f.id) cnt
    from fixtures f
    join results_history r
      on r.league = f.league and r.source = 'football-data.co.uk'
     and r.match_date::date between (f.commence_time at time zone 'UTC')::date - 1
                                and (f.commence_time at time zone 'UTC')::date + 1
     and normalize_team_tokens(r.home_team) && normalize_team_tokens(f.home_team)
     and normalize_team_tokens(r.away_team) && normalize_team_tokens(f.away_team)
    where f.league = any(target_leagues) and f.status = 'scheduled'
      and f.commence_time < now() - interval '3 hours'
  ),
  upd as (
    update fixtures f set status = 'finished', home_score = c.home_score, away_score = c.away_score
    from c where c.id = f.id and c.cnt = 1
    returning f.id
  )
  select count(*) into n from upd;
  return n;
end;
$function$;

create or replace function public.mark_stale_fixtures()
 returns integer language plpgsql security definer set search_path to 'public' as $function$
declare n int;
begin
  update fixtures set status = 'postponed'
  where status = 'scheduled' and commence_time < now() - interval '4 days';
  get diagnostics n = row_count;
  return n;
end;
$function$;

select cron.schedule('sync-history-football-data-new-daily', '25 9 * * *', $cmd$
do $job$ begin if competition_active('soccer', array['Primera División - Argentina','Brazil Série A','Liga MX','MLS']) then perform net.http_post(
    url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-history-football-data-new',
    headers := jsonb_build_object('Content-Type','application/json','apikey','<SUPABASE_ANON_KEY>','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := '{}'::jsonb, timeout_milliseconds := 120000); end if; end $job$;
$cmd$);

select cron.schedule('check-quota-daily', '45 10 * * *', $cmd$
  select net.http_post(
    url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/check-quota',
    headers := jsonb_build_object('Content-Type','application/json','apikey','<SUPABASE_ANON_KEY>','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := '{}'::jsonb, timeout_milliseconds := 30000);
$cmd$);

select cron.schedule('mark-stale-fixtures-daily', '0 11 * * *', $cmd$ select mark_stale_fixtures(); $cmd$);
