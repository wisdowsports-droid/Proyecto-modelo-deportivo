-- Evita duplicar el mismo pick de valor (mismo partido+mercado+seleccion)
-- cada vez que se vuelve a calcular tras vencer el cache de 20 min.
alter table picks add constraint picks_event_market_selection_key unique (event, market, selection);
