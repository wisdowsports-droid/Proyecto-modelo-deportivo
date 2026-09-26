-- Supabase (Postgres) version of picks_engine/tracking/schema.sql.
-- Same columns and meaning; Postgres-native types instead of SQLite's TEXT/REAL.
--
-- Apply either by pasting this file into Supabase Dashboard -> SQL Editor,
-- or with the Supabase CLI: `supabase link` + `supabase db push`.
--
-- Probabilities/odds are double precision (not numeric) on purpose: psycopg
-- returns them as Python floats, which is what picks_engine.evaluation.metrics
-- expects. numeric would come back as Decimal.

CREATE TABLE IF NOT EXISTS public.picks (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at       timestamptz NOT NULL DEFAULT now(),
    sport            text NOT NULL
                     CHECK (sport IN ('soccer', 'tennis', 'basketball', 'football', 'baseball')),
    league           text,
    event            text NOT NULL,
    event_date       date,
    market           text NOT NULL,
    selection        text NOT NULL,
    decimal_odds     double precision CHECK (decimal_odds IS NULL OR decimal_odds > 1),
    devig_method     text CHECK (devig_method IS NULL OR devig_method IN ('shin', 'multiplicative')),
    model_prob       double precision CHECK (model_prob IS NULL OR model_prob BETWEEN 0 AND 1),
    fair_market_prob double precision CHECK (fair_market_prob IS NULL OR fair_market_prob BETWEEN 0 AND 1),
    edge             double precision,
    kelly_stake      double precision CHECK (kelly_stake IS NULL OR kelly_stake >= 0),
    status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'won', 'lost', 'push', 'void', 'no_pick')),
    result_note      text,
    legacy_note      text,
    settled_at       timestamptz,
    source           text
);

CREATE INDEX IF NOT EXISTS idx_picks_status     ON public.picks (status);
CREATE INDEX IF NOT EXISTS idx_picks_sport      ON public.picks (sport);
CREATE INDEX IF NOT EXISTS idx_picks_event_date ON public.picks (event_date);

-- RLS on with no policies: the public anon key can't read or write anything
-- yet. The Python engine connects as the database owner (DATABASE_URL), which
-- bypasses RLS. Add explicit policies when the frontend needs direct access.
ALTER TABLE public.picks ENABLE ROW LEVEL SECURITY;
