select cron.schedule(
  'sync-fixtures-daily',
  '0 10 * * *',  -- 10:00 UTC = 5:00 am hora Colombia (UTC-5); ajustar si prefieres otra hora
  $$
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
  $$
);
