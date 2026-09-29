select cron.schedule(
  'sync-history-nfl-daily',
  '40 9 * * *',
  $$
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
  $$
);

select cron.schedule(
  'sync-history-mlb-daily',
  '50 9 * * *',
  $$
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
  $$
);
