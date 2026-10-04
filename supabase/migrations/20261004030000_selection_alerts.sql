-- Alerta de resultados de la Seleccion del dia. Una tarea programada de Claude
-- revisa cada hora (14:50 a 01:50, hora Bogota) selection_alert_status(): cuando
-- todos los picks validos del dia ya tienen resultado, envia la notificacion y
-- marca el dia con mark_selection_alert() para avisar una sola vez.
create table if not exists selection_alerts (pick_date date primary key, sent_at timestamptz not null default now());
alter table selection_alerts enable row level security;

create or replace function public.selection_alert_status(p_date date default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with d as (select coalesce(p_date, (now() at time zone 'America/Bogota')::date) d),
  s as (select r.* from selection_results r, d where r.pick_date = d.d),
  rec as (select count(hit) n, count(*) filter (where hit) h from selection_results)
  select jsonb_build_object(
    'fecha', (select d from d),
    'hay_seleccion', exists (select 1 from s),
    'ya_avisado', exists (select 1 from selection_alerts a, d where a.pick_date = d.d),
    'pendientes', (select count(*) from s where void_reason is null and hit is null and status not in ('postponed','cancelled')),
    'lista', exists (select 1 from s) and not exists (select 1 from s where void_reason is null and hit is null and status not in ('postponed','cancelled'))
             and not exists (select 1 from selection_alerts a, d where a.pick_date = d.d),
    'picks', (select coalesce(jsonb_agg(jsonb_build_object('rank', rank, 'partido', home_team || ' vs ' || away_team, 'pick', label,
               'prob', round(prob * 100), 'cuota_minima', min_odds, 'marcador', home_score || '-' || away_score,
               'resultado', case when void_reason is not null then 'anulado' when status in ('postponed','cancelled') then 'aplazado'
                                 when hit then 'acertado' when hit = false then 'fallado' else 'pendiente' end) order by rank), '[]'::jsonb) from s),
    'dia_aciertos', (select count(*) filter (where hit) from s), 'dia_calificados', (select count(hit) from s),
    'record_aciertos', (select h from rec), 'record_total', (select n from rec));
$$;

create or replace function public.mark_selection_alert(p_date date)
returns boolean language sql security definer set search_path = public as $$
  insert into selection_alerts (pick_date) values (p_date) on conflict do nothing returning true;
$$;
