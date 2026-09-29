-- Punto 4 del diagnostico: calibracion de los mercados de goles.
-- Chequeo historico (ultimos 365 dias, dentro de muestra) de la probabilidad
-- media del modelo contra la frecuencia real:
--   Selecciones      861 partidos  BTTS 0.510 vs 0.459  Over2.5 0.529 vs 0.531
--   Clubes Europa   1724 partidos  BTTS 0.532 vs 0.545  Over2.5 0.525 vs 0.544
--   Latam + MLS     1723 partidos  BTTS 0.513 vs 0.546  Over2.5 0.485 vs 0.506
-- Se aplica un desplazamiento por grupo a BTTS y Over 2.5 en forecast_board.
create table if not exists market_calibration (
  league_group text primary key,
  btts_shift numeric not null default 0,
  over25_shift numeric not null default 0,
  sample_n int,
  note text,
  updated_at timestamptz not null default now()
);
alter table market_calibration enable row level security;
drop policy if exists market_calibration_read on market_calibration;
create policy market_calibration_read on market_calibration for select using (true);

insert into market_calibration (league_group, btts_shift, over25_shift, sample_n, note) values
  ('selecciones',   -0.050, 0.000, 861,  'BTTS 0.510 pred vs 0.459 real'),
  ('clubes_europa',  0.013, 0.019, 1724, 'BTTS 0.532 vs 0.545; O2.5 0.525 vs 0.544'),
  ('latam_mls',      0.033, 0.021, 1723, 'BTTS 0.513 vs 0.546; O2.5 0.485 vs 0.506')
on conflict (league_group) do update set btts_shift = excluded.btts_shift, over25_shift = excluded.over25_shift,
  sample_n = excluded.sample_n, note = excluded.note, updated_at = now();

create or replace function league_group(p_league text) returns text
language sql immutable set search_path = public as $$
  select case
    when p_league = 'UEFA Nations League' then 'selecciones'
    when p_league in ('Primera División - Argentina', 'Brazil Série A', 'Liga MX', 'MLS') then 'latam_mls'
    else 'clubes_europa' end
$$;

create or replace function calibrate_prob(p numeric, shift numeric) returns numeric
language sql immutable set search_path = public as $$
  select case when p is null then null else least(0.98, greatest(0.02, p + coalesce(shift, 0))) end
$$;

-- forecast_board: mismas columnas; solo over25 y btts pasan por la calibracion.
do $mig$
declare v text := pg_get_viewdef('forecast_board'::regclass, true);
begin
  if position('calibrate_prob' in v) = 0 then
    v := replace(v, 'round(m.over25, 4) AS over25', 'round(calibrate_prob(m.over25, mc.over25_shift), 4) AS over25');
    v := replace(v, 'round(m.btts, 4) AS btts', 'round(calibrate_prob(m.btts, mc.btts_shift), 4) AS btts');
    v := replace(v, 'LEFT JOIN m ON m.id = f.id;', 'LEFT JOIN m ON m.id = f.id
     LEFT JOIN market_calibration mc ON mc.league_group = league_group(f.league) AND f.sport = ''soccer''::text;');
    execute 'create or replace view forecast_board with (security_invoker = true) as ' || v;
  end if;
end $mig$;
