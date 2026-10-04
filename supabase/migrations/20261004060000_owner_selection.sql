-- Seccion privada "Tu Seleccion del dia" en la pagina publica.
-- Solo responde si se manda la llave del dueno (app_settings.owner_key).
-- El boton del bot de Telegram abre la pagina con ?k=<llave>; la pagina la guarda
-- en el navegador y la quita de la direccion. Sin llave, la funcion devuelve null.

insert into app_settings(key, value, updated_at)
select 'owner_key', md5(random()::text || clock_timestamp()::text) || md5(random()::text || clock_timestamp()::text), now()
where not exists (select 1 from app_settings where key = 'owner_key');

create or replace function public.owner_selection(p_key text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  with ok as (select 1 from app_settings where key='owner_key' and value = p_key and length(coalesce(p_key,''))>=32),
  today as (select (now() at time zone 'America/Bogota')::date d)
  select case when exists(select 1 from ok) then jsonb_build_object(
    'date', (select d from today),
    'picks', (select coalesce(jsonb_agg(jsonb_build_object('rank',rank,'league',league,'home_team',home_team,'away_team',away_team,
                'commence_time',commence_time,'label',label,'prob',prob,'min_odds',min_odds,'hit',hit,'status',status,
                'home_score',home_score,'away_score',away_score,'void',void_reason is not null) order by rank),'[]')
              from selection_results, today where pick_date = today.d),
    'recent', (select coalesce(jsonb_agg(to_jsonb(t) order by t.pick_date desc, t.rank),'[]') from (
                select pick_date, rank, home_team, away_team, label, prob, hit, home_score, away_score
                from selection_results, today where pick_date < today.d and pick_date >= today.d - 7 and void_reason is null and hit is not null) t),
    'rec', (select jsonb_build_object('n', count(hit), 'h', count(*) filter (where hit)) from selection_results where void_reason is null))
  else null end;
$$;
revoke execute on function public.owner_selection(text) from public;
grant execute on function public.owner_selection(text) to anon, authenticated;

-- El enlace del bot (app_settings.dashboard_url) se actualiza a mano:
-- 'https://kinetikpicks.vercel.app/?k=' || owner_key
