-- Canal publico de Telegram @kinetikpics: el bot publica los gratis, sus resultados y el resumen semanal.
insert into app_settings(key, value) values ('tg_channel_id', '-1001338265177') on conflict (key) do update set value = excluded.value;

-- 6:12 a. m. Colombia: picks gratis del dia
select cron.schedule('tg-channel-free', '12 11 * * *', $c$ with k as (select substring(command from '''(eyJ[^'']+)''') v from cron.job where jobname='backfill-espn-stats-daily')
 select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/telegram-notify', headers := jsonb_build_object('Content-Type','application/json','apikey',k.v,'Authorization','Bearer '||k.v), body := '{"mode":"ch_free"}'::jsonb) from k; $c$);
-- cada 15 min: resultado de los gratis cuando terminan todos
select cron.schedule('tg-channel-results', '7,22,37,52 * * * *', $c$ with k as (select substring(command from '''(eyJ[^'']+)''') v from cron.job where jobname='backfill-espn-stats-daily')
 select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/telegram-notify', headers := jsonb_build_object('Content-Type','application/json','apikey',k.v,'Authorization','Bearer '||k.v), body := '{"mode":"ch_results"}'::jsonb) from k; $c$);
-- lunes 8:00 a. m. Colombia: resumen de la semana
select cron.schedule('tg-channel-weekly', '0 13 * * 1', $c$ with k as (select substring(command from '''(eyJ[^'']+)''') v from cron.job where jobname='backfill-espn-stats-daily')
 select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/telegram-notify', headers := jsonb_build_object('Content-Type','application/json','apikey',k.v,'Authorization','Bearer '||k.v), body := '{"mode":"ch_weekly"}'::jsonb) from k; $c$);
