-- Liga colombiana desde ESPN (funcion sync-colombia): el modelo acepta
-- 'espn' como fuente fresca de historial.
do $mig$
declare d text := pg_get_functiondef('refit_team_strengths_from_history'::regproc);
begin
  if position('''espn''' in d) = 0 then
    d := replace(d, '''international-results''];', '''international-results'', ''espn''];');
    execute d;
  end if;
end $mig$;

-- Horarios de sync-colombia (historial + fuerzas a diario; calendario y
-- calificacion otra vez en la tarde). Reemplaza <SUPABASE_ANON_KEY>.
select cron.schedule('sync-colombia-history-daily', '50 9 * * *', $cmd$
  select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-colombia',
    headers := jsonb_build_object('Content-Type','application/json','apikey','<SUPABASE_ANON_KEY>','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := '{}'::jsonb, timeout_milliseconds := 150000);
$cmd$);
select cron.schedule('sync-colombia-fixtures-pm', '20 16 * * *', $cmd$
  select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-colombia',
    headers := jsonb_build_object('Content-Type','application/json','apikey','<SUPABASE_ANON_KEY>','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := '{"history":false}'::jsonb, timeout_milliseconds := 150000);
$cmd$);
