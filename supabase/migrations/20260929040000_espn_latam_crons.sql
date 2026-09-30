-- Uruguay, Peru, Chile, Ecuador y Paraguay desde ESPN (funcion
-- sync-espn-soccer). Carga inicial de 2 anos hecha a mano con
-- {"league":"...","backfill":true}. Luego dos corridas al dia por liga,
-- escalonadas para no chocar al recalcular pronosticos.
-- Reemplaza <SUPABASE_ANON_KEY> por la anon key del proyecto al aplicar.
with j(code, am, pm) as (values
  ('uru.1','2 10 * * *','22 16 * * *'), ('per.1','4 10 * * *','24 16 * * *'),
  ('chi.1','6 10 * * *','26 16 * * *'), ('ecu.1','8 10 * * *','28 16 * * *'),
  ('par.1','10 10 * * *','30 16 * * *')),
c as (select 'sync-espn-'||replace(code,'.','')||'-'||x.t name, x.s sched, code
      from j, lateral (values ('am', am), ('pm', pm)) x(t, s))
select cron.schedule(c.name, c.sched, format($t$
  select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/sync-espn-soccer',
    headers := jsonb_build_object('Content-Type','application/json','apikey','<SUPABASE_ANON_KEY>','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := '{"league":"%s"}'::jsonb, timeout_milliseconds := 120000);
$t$, c.code)) from c;
