-- Ligas gratis (sync-free-leagues): 12 ligas europeas + 7 de otros paises
-- desde football-data.co.uk, sin gastar creditos de The Odds API.
-- El calendario se publica pocos dias antes de cada jornada, por eso se
-- revisa dos veces al dia. El historial (y las fuerzas) una vez al dia.
-- Reemplaza <SUPABASE_ANON_KEY> por la anon key del proyecto al aplicar.
select cron.schedule('sync-free-leagues-fixtures-am', '15 8 * * *', $cmd$
  select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-free-leagues',
    headers := jsonb_build_object('Content-Type','application/json','apikey','<SUPABASE_ANON_KEY>','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := '{"part":"fixtures"}'::jsonb, timeout_milliseconds := 120000);
$cmd$);
select cron.schedule('sync-free-leagues-fixtures-pm', '15 16 * * *', $cmd$
  select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-free-leagues',
    headers := jsonb_build_object('Content-Type','application/json','apikey','<SUPABASE_ANON_KEY>','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := '{"part":"fixtures"}'::jsonb, timeout_milliseconds := 120000);
$cmd$);
select cron.schedule('sync-free-leagues-history-main', '35 9 * * *', $cmd$
  select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-free-leagues',
    headers := jsonb_build_object('Content-Type','application/json','apikey','<SUPABASE_ANON_KEY>','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := '{"part":"main"}'::jsonb, timeout_milliseconds := 150000);
$cmd$);
select cron.schedule('sync-free-leagues-history-new', '40 9 * * *', $cmd$
  select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-free-leagues',
    headers := jsonb_build_object('Content-Type','application/json','apikey','<SUPABASE_ANON_KEY>','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := '{"part":"new"}'::jsonb, timeout_milliseconds := 150000);
$cmd$);
