# Supabase — respaldo del backend

Copia de lo que corre en el proyecto Supabase `vritcqtzvvjwxmbmzsgy` (exportado el 2026-09-28).

- `functions/` — las 12 Edge Functions (Deno/TypeScript) que traen partidos, cuotas y resultados de las APIs gratuitas.
- `migrations/` — historial real de migraciones aplicadas en Supabase (tablas, funciones SQL del modelo, trigger de liquidación).
  El archivo `20260922000000_create_picks.sql` es el esquema local previo; la tabla real la crea `20260923015938_create_picks_table.sql`.
- `cron_jobs.sql` — las 8 tareas programadas (pg_cron) activas.
- `../dashboard/kinetik-picks.html` — el dashboard Kinetik Picks.

## Secretos (no están en el repo)

Configurados en Supabase → Edge Functions → Secrets: `ODDS_API_KEY`, `API_FOOTBALL_KEY`, `FOOTBALL_DATA_ORG_KEY`.
En `cron_jobs.sql`, las migraciones de cron y el dashboard, `<SUPABASE_ANON_KEY>` reemplaza la anon key del proyecto
(Dashboard → Settings → API) — hay que ponerla de nuevo si se restauran.
