alter table event_markets add column if not exists recommendations jsonb not null default '{}'::jsonb;
alter table event_markets add column if not exists model_used boolean not null default false;
