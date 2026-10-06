-- Corners y tarjetas para ligas latinoamericanas y MLS (fuente: resumen de partido de ESPN).
-- La funcion backfill-espn-stats completa results_history; aqui va el resto.

alter table public.results_history add column if not exists stats_checked_at timestamptz;

-- refit: tarjetas nulas cuando no hay dato (antes contaban como 0) y solo estimar
-- corners/tarjetas en ligas con al menos 150 partidos con ese dato.
do $$
declare src text := pg_get_functiondef('public.refit_team_strengths_from_history(text[],integer)'::regprocedure);
begin
  src := replace(src, 'coalesce(home_yellow,0)+coalesce(home_red,0) hk, coalesce(away_yellow,0)+coalesce(away_red,0) ak',
    'case when home_yellow is null then null else home_yellow+coalesce(home_red,0) end hk, case when away_yellow is null then null else away_yellow+coalesce(away_red,0) end ak');
  if position('having count(home_corners) >= 150' in src) = 0 then
    src := replace(src, 'avg(hk) hk, avg(ak) ak, (avg(hk)+avg(ak))/2.0 k_all
    from raw group by league', 'avg(hk) hk, avg(ak) ak, (avg(hk)+avg(ak))/2.0 k_all
    from raw group by league
    having count(home_corners) >= 150  -- con menos partidos con corners/tarjetas no se estiman');
  end if;
  execute src;
end $$;

-- cada dia completa los partidos nuevos
select cron.schedule('backfill-espn-stats-daily', '50 10 * * *', $cron$
  with k as (select '<SUPABASE_ANON_KEY>' v),
  b(l) as (values ('Liga BetPlay (Colombia Primera A)'),('Primera División - Uruguay'),('Liga 1 - Peru'),('Primera División - Chile'),('LigaPro - Ecuador'),('Primera División - Paraguay'),('Primera División - Argentina'),('Brazil Série A'),('Liga MX'),('MLS'))
  select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/backfill-espn-stats',
    headers := jsonb_build_object('Content-Type','application/json','apikey',k.v,'Authorization','Bearer '||k.v),
    body := jsonb_build_object('league', b.l, 'limit', 80), timeout_milliseconds := 150000) from b, k;
$cron$);
