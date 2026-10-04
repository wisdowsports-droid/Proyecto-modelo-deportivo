-- Alertas por Telegram (funcion telegram-notify, bot @Kinetikpicks_alertas_bot).
-- Requiere el secreto TELEGRAM_BOT_TOKEN en Supabase -> Edge Functions -> Secrets
-- (lo guarda el dueno del proyecto; nunca va en el repositorio).
create table if not exists app_settings (key text primary key, value text, updated_at timestamptz not null default now());
alter table app_settings enable row level security;
create table if not exists telegram_sent (kind text not null, ref_date date not null, sent_at timestamptz not null default now(), primary key (kind, ref_date));
alter table telegram_sent enable row level security;
-- Reemplaza <SUPABASE_ANON_KEY> por la anon key del proyecto al aplicar.
-- 6:10 a. m. Bogota: picks de la Seleccion del dia (se publica a las 6:05).
select cron.schedule('telegram-morning-picks', '10 11 * * *', $cmd$
  select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/telegram-notify',
    headers := jsonb_build_object('Content-Type','application/json','apikey','<SUPABASE_ANON_KEY>','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := '{"mode":"morning"}'::jsonb, timeout_milliseconds := 30000);
$cmd$);
-- Cada 15 min: si ya terminaron todos los picks del dia, manda el resumen (una vez).
select cron.schedule('telegram-selection-results', '*/15 * * * *', $cmd$
  select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/telegram-notify',
    headers := jsonb_build_object('Content-Type','application/json','apikey','<SUPABASE_ANON_KEY>','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := '{"mode":"results"}'::jsonb, timeout_milliseconds := 30000);
$cmd$);
