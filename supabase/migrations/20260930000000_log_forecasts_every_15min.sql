-- El registro congelado se tomaba cada hora: un partido que entraba al
-- calendario menos de 1 hora antes de empezar (ej. Medellin vs Millonarios,
-- 29/09) quedaba sin registrar. Ahora cada 15 minutos.
select cron.alter_job((select jobid from cron.job where jobname = 'log-forecasts-hourly'), schedule := '*/15 * * * *');
