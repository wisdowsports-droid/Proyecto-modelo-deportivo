-- OddsPapi: cuotas de BetPlay frente al precio justo de Pinnacle (radar de valor para el dueno).
-- La funcion oddspapi-sync llena bp_lines (ultimas cuotas) y bp_value (senales, se registran una sola vez).
create table if not exists public.op_participants (id int primary key, name text not null);
create table if not exists public.bp_lines (
  op_fixture_id text not null, outcome_id int not null,
  fixture_id bigint references public.fixtures(id) on delete set null,
  tournament_id int, home text, away text, kickoff timestamptz,
  market text, selection text, line numeric,
  bp_price numeric, pin_price numeric, pin_fair numeric, edge numeric,
  updated_at timestamptz default now(),
  primary key (op_fixture_id, outcome_id)
);
create index if not exists bp_lines_kickoff_idx on public.bp_lines(kickoff);
create table if not exists public.bp_value (
  op_fixture_id text not null, outcome_id int not null,
  fixture_id bigint references public.fixtures(id) on delete set null,
  home text, away text, kickoff timestamptz, market text, selection text, line numeric,
  bp_price numeric, pin_price numeric, pin_fair numeric, edge numeric,
  detected_at timestamptz default now(),
  primary key (op_fixture_id, outcome_id)
);
create table if not exists public.op_usage (month text primary key, calls int not null default 0, meta jsonb not null default '{}');
alter table public.op_participants enable row level security;
alter table public.bp_lines enable row level security;
alter table public.bp_value enable row level security;
alter table public.op_usage enable row level security;
revoke all on public.op_participants, public.bp_lines, public.bp_value, public.op_usage from anon, authenticated;

create or replace view public.bp_value_results as
select v.*, f.home_score, f.away_score,
  case when f.home_score is null then null
    when v.market = '1x2' then (v.selection = '1' and f.home_score > f.away_score) or (v.selection = 'X' and f.home_score = f.away_score) or (v.selection = '2' and f.home_score < f.away_score)
    when v.market = 'totals' then case when v.selection = 'Over' then f.home_score + f.away_score > v.line else f.home_score + f.away_score < v.line end
    when v.market = 'btts' then (v.selection = 'Yes') = (f.home_score > 0 and f.away_score > 0)
  end hit,
  -- ventaja frente a la ultima linea de Pinnacle antes del partido (CLV): la prueba mas honesta de valor
  round(v.bp_price * l.pin_fair - 1, 4) close_edge
from public.bp_value v
left join public.fixtures f on f.id = v.fixture_id
left join public.bp_lines l on l.op_fixture_id = v.op_fixture_id and l.outcome_id = v.outcome_id;
revoke all on public.bp_value_results from anon, authenticated;

create or replace function public.owner_bp_value(p_key text)
returns jsonb language sql stable security definer set search_path to 'public' as $$
  with ok as (select 1 from app_settings where key='owner_key' and value = p_key and length(coalesce(p_key,''))>=32)
  select case when exists(select 1 from ok) then jsonb_build_object(
    'upcoming', (select coalesce(jsonb_agg(to_jsonb(t) order by t.kickoff), '[]') from (
       select v.home, v.away, v.kickoff, v.market, v.selection, v.line, v.bp_price, v.pin_fair, v.edge, l.bp_price bp_now, l.edge edge_now
       from bp_value v left join bp_lines l using (op_fixture_id, outcome_id)
       where v.kickoff > now() order by v.kickoff limit 60) t),
    'record', (select jsonb_build_object('n', count(*), 'hits', count(*) filter (where hit),
       'profit', round(coalesce(sum(case when hit then bp_price - 1 else -1 end), 0), 2),
       'avg_close_edge', round(avg(close_edge) * 100, 2))
       from bp_value_results where hit is not null))
  else null end;
$$;
revoke execute on function public.owner_bp_value(text) from public;
grant execute on function public.owner_bp_value(text) to anon, authenticated;

-- todos los dias 12:40 p. m. hora Colombia
select cron.schedule('oddspapi-sync-daily', '40 17 * * *', $cron$
  with k as (select substring(command from '''(eyJ[^'']+)''') v from cron.job where jobname='backfill-espn-stats-daily')
  select net.http_post(url := 'https://vritcqtzvvjwxmbmzsgy.supabase.co/functions/v1/oddspapi-sync',
    headers := jsonb_build_object('Content-Type','application/json','apikey',k.v,'Authorization','Bearer '||k.v),
    body := '{}'::jsonb, timeout_milliseconds := 150000) from k;
$cron$);
