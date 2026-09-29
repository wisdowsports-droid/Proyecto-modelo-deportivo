-- Modelo de selecciones: el refit tambien usa la fuente 'international-results'
-- (martj42/international_results, cargada por sync-history-international).
do $$
declare def text;
begin
  select pg_get_functiondef('public.refit_team_strengths_from_history(text[], integer)'::regprocedure) into def;
  if position('international-results' in def) = 0 then
    def := replace(def, 'array[''football-data.co.uk'', ''football-data.org'']',
                        'array[''football-data.co.uk'', ''football-data.org'', ''international-results'']');
    execute def;
  end if;
end $$;

-- Actualizacion diaria del historial de selecciones (no gasta creditos de The Odds API).
select cron.schedule('sync-history-international-daily', '20 9 * * *', $$
  select net.http_post(
    url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-history-international',
    headers := jsonb_build_object('Content-Type','application/json','apikey','<SUPABASE_ANON_KEY>','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
$$);
