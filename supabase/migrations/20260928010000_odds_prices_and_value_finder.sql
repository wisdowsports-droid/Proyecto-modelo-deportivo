-- Buscador de cuotas: guarda la cuota 1X2 de cada casa por partido y el
-- "precio justo" de Pinnacle sin margen (Shin). Validado con backtest
-- (backtest-lineshop, ~75.000 partidos, 35 ligas): apostar a la mejor cuota
-- cuando supera el precio justo de Pinnacle dio +1.8% (EV 2-5%), +5.5%
-- (EV 5-10%), +12.6% (EV >10%), positivo en 21-25 de 35 ligas.

create table if not exists odds_prices (
  fixture_id    bigint not null references fixtures(id) on delete cascade,
  bookmaker_key text not null,
  bookmaker     text not null,
  price_home    numeric,
  price_draw    numeric,
  price_away    numeric,
  last_update   timestamptz,
  fetched_at    timestamptz not null default now(),
  primary key (fixture_id, bookmaker_key)
);
alter table odds_prices enable row level security;
create policy "odds_prices public read" on odds_prices for select to anon, authenticated using (true);

alter table fixtures add column if not exists fair_home numeric;
alter table fixtures add column if not exists fair_draw numeric;
alter table fixtures add column if not exists fair_away numeric;
alter table fixtures add column if not exists fair_source text;
alter table fixtures add column if not exists fair_updated_at timestamptz;
alter table fixtures add column if not exists pinnacle_last_update timestamptz;

-- Una fila por (partido, resultado, casa) con su valor esperado contra el
-- precio justo. Excluye Pinnacle (es la referencia) y casas de intercambio
-- (cobran comision, su cuota no es comparable directo). Solo compara cuotas
-- tomadas cerca del mismo momento que la de Pinnacle (<= 3 h de diferencia).
create or replace view value_opportunities with (security_invoker = true) as
select f.id fixture_id, f.sport, f.league, f.home_team, f.away_team, f.commence_time,
       o.outcome, p.bookmaker, p.bookmaker_key, o.price,
       o.fair fair_prob, round(1 / o.fair, 3) fair_odds,
       round(o.price * o.fair - 1, 4) ev,
       p.last_update, f.pinnacle_last_update, p.fetched_at
from fixtures f
join odds_prices p on p.fixture_id = f.id
cross join lateral (values ('Local', p.price_home, f.fair_home),
                           ('Empate', p.price_draw, f.fair_draw),
                           ('Visitante', p.price_away, f.fair_away)) o(outcome, price, fair)
where f.status = 'scheduled' and f.commence_time > now()
  and f.fair_source = 'pinnacle' and o.fair is not null and o.fair > 0 and o.price is not null
  and p.bookmaker_key <> 'pinnacle'
  and p.bookmaker_key not like '%\_ex\_%' escape '\' and p.bookmaker_key <> 'matchbook'
  and abs(extract(epoch from (p.last_update - f.pinnacle_last_update))) <= 3 * 3600;

grant select on value_opportunities to anon, authenticated;
