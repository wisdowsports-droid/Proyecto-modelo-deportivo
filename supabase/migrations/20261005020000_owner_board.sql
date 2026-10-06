-- Parrilla completa (Pro) para el dueno en la pagina publica: solo responde con la llave owner_key.
create or replace function public.owner_board(p_key text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  with ok as (select 1 from app_settings where key='owner_key' and value = p_key and length(coalesce(p_key,''))>=32)
  select case when exists(select 1 from ok) then jsonb_build_object(
    'upcoming', (select coalesce(jsonb_agg(to_jsonb(t) order by t.commence_time), '[]') from (
       select league, home_team, away_team, commence_time, source, pick, pick_prob, confidence,
         p_home, p_draw, p_away, dc_pick, dc_prob, over15, over25, over35, btts, top_home, top_away, top_prob,
         corners_exp, corners_over95, cards_exp, cards_over45
       from forecast_board where sport='soccer' and commence_time > now() - interval '2 hours' and commence_time < now() + interval '3 days'
       order by commence_time limit 150) t),
    'recent', (select coalesce(jsonb_agg(to_jsonb(t) order by t.commence_time desc), '[]') from (
       select league, home_team, away_team, commence_time, pick, pick_prob, confidence, home_score, away_score,
         hit_result, dc_pick, dc_prob, hit_dc, over15, hit_over15, over25, hit_over25, btts, hit_btts
       from forecast_results where sport='soccer' and commence_time > now() - interval '48 hours' and home_score is not null
       order by commence_time desc limit 80) t))
  else null end;
$$;
revoke execute on function public.owner_board(text) from public;
grant execute on function public.owner_board(text) to anon, authenticated;

-- Ingesta de mensajes de tipsters (creada y luego deshabilitada: no se usa)
create table if not exists public.tipster_messages (
  channel_id bigint not null, channel text, mid int not null, msg_date timestamptz, text text,
  media_type text, views int, edited boolean, loaded_at timestamptz default now(),
  primary key (channel_id, mid)
);
alter table public.tipster_messages enable row level security;
revoke all on public.tipster_messages from anon, authenticated;
