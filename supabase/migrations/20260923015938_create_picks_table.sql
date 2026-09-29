-- Every pick this project makes gets one row here, from creation to
-- settlement. Public dashboard reads this table directly (via the
-- publishable/anon key + RLS below); writes happen only from trusted
-- contexts (this Supabase MCP connection, or a service-role key), never
-- from the public dashboard.

CREATE TABLE IF NOT EXISTS picks (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    sport             TEXT NOT NULL,             -- 'soccer' | 'tennis' | 'basketball' | 'football' | 'baseball'
    league            TEXT,                      -- e.g. 'Liga BetPlay', 'UEFA Women''s Champions League', 'ATP'
    event             TEXT NOT NULL,             -- 'Independiente Medellin vs Jaguares de Cordoba'
    event_date        DATE,
    market            TEXT NOT NULL,             -- 'moneyline' | 'double_chance_1x' | 'over_under_2.5' | 'spread' | ...
    selection         TEXT NOT NULL,             -- human-readable: what was actually picked
    decimal_odds      NUMERIC,                   -- NULL when the exact market price wasn't captured
    devig_method      TEXT,                      -- 'shin' | 'multiplicative' | NULL
    model_prob        NUMERIC,                   -- NULL for legacy/qualitative picks with no real model behind them
    fair_market_prob  NUMERIC,
    edge              NUMERIC,
    kelly_stake       NUMERIC,                   -- recommended stake, fraction of paper bankroll
    status            TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','won','lost','push','void','no_pick')),
    result_note       TEXT,                      -- e.g. 'Real Madrid 1-1 PSG'
    legacy_note       TEXT,                      -- old qualitative reasoning kept for provenance, never fed to evaluation
    settled_at        TIMESTAMPTZ,
    source            TEXT                       -- free text provenance, e.g. 'legacy:doc-353c8eca' or 'engine:v1'
);

CREATE INDEX IF NOT EXISTS idx_picks_status ON picks(status);
CREATE INDEX IF NOT EXISTS idx_picks_sport ON picks(sport);
CREATE INDEX IF NOT EXISTS idx_picks_event_date ON picks(event_date);

ALTER TABLE picks ENABLE ROW LEVEL SECURITY;

-- Public dashboard (anon/publishable key) can read every row.
CREATE POLICY "Public read access" ON picks
    FOR SELECT
    TO anon, authenticated
    USING (true);

-- No insert/update/delete policy for anon/authenticated on purpose: the
-- public dashboard is read-only. Writes go through this MCP connection
-- (which connects as the database owner / service context) or a
-- service-role key, both of which bypass RLS entirely.
