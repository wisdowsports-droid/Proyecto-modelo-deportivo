-- Actualizacion automatica del buscador de cuotas antes de los partidos.
-- Cada hora revisa si hay partidos de futbol que empiezan en 1-3 horas y,
-- para esas ligas, llama a refresh-odds (1 credito de The Odds API por liga).
-- Limites para no quemar la cuota mensual (500):
--   * cada liga se actualiza como maximo una vez cada 8 horas;
--   * si quedan menos de 80 creditos se detiene (reserva para sync-results);
--   * arranca el 2026-10-01, cuando se renuevan los creditos.

create table if not exists api_quota (
  api text primary key,
  remaining int,
  updated_at timestamptz not null default now()
);
alter table api_quota enable row level security;
create policy "api_quota public read" on api_quota for select to anon, authenticated using (true);

create table if not exists odds_refresh_log (
  id bigint generated always as identity primary key,
  requested_at timestamptz not null default now(),
  sport_keys text[] not null,
  request_id bigint,
  reason text
);
alter table odds_refresh_log enable row level security;

create or replace function schedule_odds_refresh()
returns text language plpgsql security definer set search_path = public, extensions as $$
declare
  keys text[];
  remaining int;
  req bigint;
  anon text := '<SUPABASE_ANON_KEY>';
begin
  if now() < timestamptz '2026-10-01 00:00:00-05' then return 'aun no: arranca el 1 de octubre'; end if;

  select q.remaining into remaining from api_quota q where q.api = 'the-odds-api';
  if remaining is not null and remaining < 80 then return 'pausado: quedan ' || remaining || ' creditos'; end if;

  select array_agg(distinct f.odds_api_sport_key) into keys
  from fixtures f
  where f.sport = 'soccer' and f.status = 'scheduled' and f.odds_api_sport_key is not null
    and f.commence_time between now() + interval '1 hour' and now() + interval '3 hours'
    and not exists (
      select 1 from odds_refresh_log l
      where f.odds_api_sport_key = any(l.sport_keys) and l.requested_at > now() - interval '8 hours'
    );

  if keys is null or array_length(keys, 1) is null then return 'nada que actualizar'; end if;

  select net.http_post(
    url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/refresh-odds',
    headers := jsonb_build_object('Content-Type','application/json','apikey', anon,'Authorization','Bearer ' || anon),
    body := jsonb_build_object('sport_keys', to_jsonb(keys)),
    timeout_milliseconds := 120000
  ) into req;

  insert into odds_refresh_log (sport_keys, request_id, reason) values (keys, req, 'antes del partido');
  return 'actualizando: ' || array_to_string(keys, ', ');
end;
$$;

select cron.schedule('refresh-odds-before-kickoff', '5 * * * *', $$ select schedule_odds_refresh(); $$);

-- (aplicado despues) revocar ejecucion publica
revoke execute on function schedule_odds_refresh() from anon, authenticated, public;
