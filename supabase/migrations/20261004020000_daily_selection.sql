-- Seleccion del dia: maximo 5 picks de futbol de mayor probabilidad, en los
-- mercados que la prueba con temporadas anteriores mostro confiables en el
-- tramo alto (80%+): doble oportunidad 86,7%, resultado 1X2 85,9%,
-- mas de 1,5 goles 82,1%, menos de 3,5 goles 81,3%. Un pick por partido
-- (el mas probable). Cada pick trae la cuota minima para que valga la pena
-- (1,03 / probabilidad: punto de equilibrio + 3% de colchon).
-- Se publica y CONGELA cada manana a las 6:05 a. m. (Bogota) y se califica sola.
create table if not exists selection_picks (
  pick_date date not null,
  fixture_id bigint not null,  -- sin FK: crearla bloquea fixtures, que se escribe cada pocos minutos
  rank int not null,
  league text, home_team text, away_team text, commence_time timestamptz,
  market text not null,       -- dc_1X | dc_X2 | win_home | win_away | over15 | under35
  label text not null,
  prob numeric not null,
  min_odds numeric not null,
  published_at timestamptz not null default now(),
  void_reason text,           -- pick anulado (p. ej. partido duplicado); no cuenta en el recórd
  primary key (pick_date, fixture_id)
);
alter table selection_picks enable row level security;
drop policy if exists selection_picks_read on selection_picks;
create policy selection_picks_read on selection_picks for select using (true);

create or replace function public.publish_selection(p_max int default 5, p_min_prob numeric default 0.75)
 returns integer language plpgsql security definer set search_path to 'public' as $function$
declare d date := (now() at time zone 'America/Bogota')::date; n int;
begin
  if exists (select 1 from selection_picks where pick_date = d) then return 0; end if;
  with b as (
    select * from forecast_board
    where sport = 'soccer' and commence_time > now() + interval '30 minutes'
      and (commence_time at time zone 'America/Bogota')::date = d
  ), c as (
    select fixture_id, league, home_team, away_team, commence_time,
      case when dc_pick = '1X' then 'dc_1X' else 'dc_X2' end market,
      case when dc_pick = '1X' then home_team else away_team end || ' o empate' label, dc_prob prob
    from b where source = 'modelo + mercado' and dc_prob is not null
    union all
    select fixture_id, league, home_team, away_team, commence_time,
      case when pick = 'Local' then 'win_home' else 'win_away' end,
      'Gana ' || case when pick = 'Local' then home_team else away_team end, pick_prob
    from b where source = 'modelo + mercado' and pick in ('Local', 'Visitante')
    union all
    select fixture_id, league, home_team, away_team, commence_time, 'over15', 'Más de 1,5 goles', over15
    from b where over15 is not null
    union all
    select fixture_id, league, home_team, away_team, commence_time, 'under35', 'Menos de 3,5 goles', 1 - over35
    from b where over35 is not null
  ), best as (
    select distinct on (fixture_id) * from c where prob >= p_min_prob order by fixture_id, prob desc
  )
  insert into selection_picks (pick_date, fixture_id, rank, league, home_team, away_team, commence_time, market, label, prob, min_odds)
  select d, fixture_id, row_number() over (order by prob desc), league, home_team, away_team, commence_time,
    market, label, round(prob, 4), round(1.03 / prob, 2)
  from best order by prob desc limit p_max;
  get diagnostics n = row_count;
  return n;
end;
$function$;

create or replace view selection_results with (security_invoker = true) as
select s.pick_date, s.fixture_id, s.rank, s.league, s.home_team, s.away_team, s.commence_time, s.market, s.label, s.prob, s.min_odds, s.published_at,
  f.status, f.home_score, f.away_score,
  case when s.void_reason is not null or f.status <> 'finished' or f.home_score is null then null
       when s.market = 'dc_1X' then f.home_score >= f.away_score
       when s.market = 'dc_X2' then f.away_score >= f.home_score
       when s.market = 'win_home' then f.home_score > f.away_score
       when s.market = 'win_away' then f.away_score > f.home_score
       when s.market = 'over15' then f.home_score + f.away_score > 1
       when s.market = 'under35' then f.home_score + f.away_score < 4 end as hit,
  s.void_reason
from selection_picks s join fixtures f on f.id = s.fixture_id;

-- Partidos duplicados: The Odds API a veces deja la fila vieja de un partido
-- reprogramado (p. ej. Boca vs Union: 23/09 -> jugado 02/10). Mismo partido
-- (liga + local + visitante) repetido en 20 dias: si una copia termino, las
-- demas sobran; si no, se queda la mas actualizada. Las sobrantes -> cancelled.
create or replace function public.mark_duplicate_fixtures() returns integer
language plpgsql security definer set search_path to 'public' as $function$
declare n int;
begin
  with d as (
    select id, status,
      row_number() over (partition by league, home_team, away_team
        order by (status = 'finished') desc, coalesce(odds_updated_at, created_at) desc, id desc) rn
    from fixtures
    where status in ('scheduled', 'finished') and commence_time > now() - interval '20 days'
  )
  update fixtures f set status = 'cancelled'
  from d where d.id = f.id and d.rn > 1 and f.status = 'scheduled';
  get diagnostics n = row_count;
  return n;
end;
$function$;
select cron.schedule('mark-duplicate-fixtures-hourly', '35 * * * *', 'select mark_duplicate_fixtures();');

select cron.schedule('publish-selection-daily', '5 11 * * *', $cmd$ select publish_selection(); $cmd$);
