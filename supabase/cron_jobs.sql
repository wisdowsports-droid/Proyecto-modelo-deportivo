-- Tareas programadas (pg_cron) activas en Supabase, exportadas el 2026-09-28.
-- <SUPABASE_ANON_KEY>: reemplazar por la anon key del proyecto (Dashboard -> Settings -> API).

select cron.schedule('sync-fixtures-every-2-days', '0 10 */2 * *', $$
  select net.http_post(
    url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-fixtures',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<SUPABASE_ANON_KEY>',
      'Authorization', 'Bearer <SUPABASE_ANON_KEY>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$);

select cron.schedule('sync-results-daily', '30 10 * * *', $$
  select net.http_post(
    url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-results',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<SUPABASE_ANON_KEY>',
      'Authorization', 'Bearer <SUPABASE_ANON_KEY>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$);

select cron.schedule('sync-history-football-data-co-uk-daily', '0 9 * * *', $$
  select net.http_post(
    url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-history-football-data-co-uk',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<SUPABASE_ANON_KEY>',
      'Authorization', 'Bearer <SUPABASE_ANON_KEY>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$);

select cron.schedule('sync-history-football-data-org-daily', '15 9 * * *', $$
  select net.http_post(
    url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-history-football-data-org',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<SUPABASE_ANON_KEY>',
      'Authorization', 'Bearer <SUPABASE_ANON_KEY>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$);

select cron.schedule('sync-history-wnba-daily', '30 9 * * *', $$
  select net.http_post(
    url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-history-wnba',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<SUPABASE_ANON_KEY>',
      'Authorization', 'Bearer <SUPABASE_ANON_KEY>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$);

select cron.schedule('sync-history-nfl-daily', '40 9 * * *', $$
  select net.http_post(
    url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-history-nfl',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<SUPABASE_ANON_KEY>',
      'Authorization', 'Bearer <SUPABASE_ANON_KEY>'
    ),
    body := jsonb_build_object('seasons', jsonb_build_array(2026)),
    timeout_milliseconds := 30000
  );
  $$);

select cron.schedule('sync-history-mlb-daily', '50 9 * * *', $$
  select net.http_post(
    url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-history-mlb',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<SUPABASE_ANON_KEY>',
      'Authorization', 'Bearer <SUPABASE_ANON_KEY>'
    ),
    body := jsonb_build_object('startDate', '2026-03-01', 'endDate', '2026-11-30'),
    timeout_milliseconds := 60000
  );
  $$);

select cron.schedule('sync-history-nba-daily', '0 10 * * *', $$
  select net.http_post(
    url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-history-nba',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<SUPABASE_ANON_KEY>',
      'Authorization', 'Bearer <SUPABASE_ANON_KEY>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$);

