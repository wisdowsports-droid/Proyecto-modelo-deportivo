-- (Ya aplicado en Supabase; deja constancia en el repo.)
-- 1) Europa League: sync-fixtures agrega soccer_uefa_europa_league; settle-espn mapea "UEFA Europa League" -> uefa.europa;
--    forecast_board y cup-home-league-daily tratan la Europa League como copa (goles/corners desde ligas locales).
-- 2) owner_selection devuelve 'parlays' (doble/triple de la Seleccion) y 'cuota' (doble/triple "con mas cuota").
-- 3) "Con mas cuota": 3 dobles oportunidades de 75-86 % (en vivo aciertan 86-90 %). Prueba 14 dias: doble 11/14 (1,43), triple 10/14 (1,76).

create table if not exists public.parlay_picks (
  pick_date date not null, kind text not null, rk int not null,
  fixture_id bigint references public.fixtures(id), league text, home_team text, away_team text, commence_time timestamptz,
  market text, label text, prob numeric, created_at timestamptz default now(),
  primary key (pick_date, kind, rk));
alter table public.parlay_picks enable row level security;
revoke all on public.parlay_picks from anon, authenticated;

create or replace function public.publish_value_parlay(p_date date default (now() at time zone 'America/Bogota')::date)
returns int language plpgsql security definer set search_path to 'public' as $$
declare n int;
begin
  if exists (select 1 from parlay_picks where pick_date = p_date and kind = 'cuota') then return 0; end if;
  insert into parlay_picks(pick_date, kind, rk, fixture_id, league, home_team, away_team, commence_time, market, label, prob)
  select p_date, 'cuota', row_number() over (order by dc_prob desc), fixture_id, league, home_team, away_team, commence_time,
         'dc_' || dc_pick, case when dc_pick = '1X' then home_team else away_team end || ' o empate', dc_prob
  from (select * from forecast_board
        where sport = 'soccer' and dc_prob between 0.75 and 0.86
          and commence_time > now() + interval '30 minutes'
          and commence_time >= (p_date::timestamp + interval '6 hours') at time zone 'America/Bogota'
          and commence_time <  ((p_date + 1)::timestamp + interval '6 hours') at time zone 'America/Bogota'
        order by dc_prob desc limit 3) x;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.publish_value_parlay(date) from public, anon, authenticated;

create or replace view public.parlay_results as
select p.*, f.home_score, f.away_score, f.status,
  case when f.status = 'finished' and f.home_score is not null then
    case p.market when 'dc_1X' then f.home_score >= f.away_score when 'dc_X2' then f.away_score >= f.home_score end end hit
from parlay_picks p left join fixtures f on f.id = p.fixture_id;
revoke all on public.parlay_results from anon, authenticated;

-- cron: publish-value-parlay-daily  '2 11 * * *'  select public.publish_value_parlay()
