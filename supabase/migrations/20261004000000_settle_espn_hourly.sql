-- Calificacion de respaldo con ESPN (funcion settle-espn): cada hora cierra
-- los partidos de futbol ya jugados que su fuente principal no ha calificado
-- (football-data publica 1-2 veces por semana; la consulta de resultados de
-- The Odds API no cubre todas las ligas, p. ej. Champions femenina).
-- Reemplaza <SUPABASE_ANON_KEY> por la anon key del proyecto al aplicar.
select cron.schedule('settle-espn-hourly', '40 * * * *', $cmd$
  select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/settle-espn',
    headers := jsonb_build_object('Content-Type','application/json','apikey','<SUPABASE_ANON_KEY>','Authorization','Bearer <SUPABASE_ANON_KEY>'),
    body := '{}'::jsonb, timeout_milliseconds := 120000);
$cmd$);
