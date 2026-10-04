-- Lista de espera de Kinetik Pro (la llena la funcion telegram-webhook).
create table if not exists public.pro_waitlist (
  tg_user_id bigint primary key,
  chat_id text not null,
  first_name text,
  username text,
  language text,
  joined_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  messages int not null default 1,
  active boolean not null default true
);
alter table public.pro_waitlist enable row level security;
revoke all on public.pro_waitlist from anon, authenticated;

insert into app_settings(key, value, updated_at) values
 ('public_url', 'https://kinetikpicks.vercel.app/', now()),
 ('tg_webhook_secret', md5(random()::text || clock_timestamp()::text) || md5(clock_timestamp()::text || random()::text), now())
on conflict (key) do nothing;

-- Registro del webhook (una vez, despues de desplegar telegram-webhook con verify_jwt = false):
-- select net.http_post(url := '<SUPABASE_URL>/functions/v1/telegram-webhook',
--   headers := '{"Content-Type":"application/json"}'::jsonb,
--   body := jsonb_build_object('setup', (select value from app_settings where key = 'tg_webhook_secret')));
