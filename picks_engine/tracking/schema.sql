-- Every pick this project ever makes gets one row here, from creation to
-- settlement. This replaces "narrate results in a Claude Doc table" with an
-- actual queryable history, which is the whole point of moving to code:
-- picks_engine.evaluation.metrics needs many rows to say anything meaningful,
-- and a doc table doesn't give you that for free.

CREATE TABLE IF NOT EXISTS picks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      TEXT NOT NULL,             -- ISO 8601, UTC
    sport           TEXT NOT NULL,             -- 'soccer' | 'tennis' | 'basketball' | 'football' | 'baseball'
    league          TEXT,                      -- e.g. 'Liga BetPlay', 'UEFA Women''s Champions League', 'ATP'
    event           TEXT NOT NULL,             -- 'Independiente Medellin vs Jaguares de Cordoba'
    event_date      TEXT,                      -- ISO 8601 date of the event, when known
    market          TEXT NOT NULL,             -- 'moneyline' | 'double_chance_1x' | 'over_under_2.5' | 'spread' | ...
    selection       TEXT NOT NULL,             -- human-readable: what was actually picked
    decimal_odds    REAL,                      -- NULL when the exact market price wasn't captured (e.g. some legacy imports only had the 1X2 legs, not this market's own quote)
    devig_method    TEXT,                      -- 'shin' | 'multiplicative' | NULL (legacy picks with no devig run)
    model_prob      REAL,                      -- NULL for legacy/qualitative picks with no real model behind them
    fair_market_prob REAL,
    edge            REAL,
    kelly_stake     REAL,                      -- recommended stake, fraction of paper bankroll
    status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'won' | 'lost' | 'push' | 'void' | 'no_pick'
    result_note     TEXT,                      -- e.g. 'Real Madrid 1-1 PSG'
    legacy_note     TEXT,                      -- free text: old qualitative reasoning (confidence words, hand-set "prob_modelo", etc) kept for provenance, never fed to evaluation
    settled_at      TEXT,
    source          TEXT                       -- free text provenance, e.g. 'legacy:doc-353c8eca' or 'engine:v1'
);

CREATE INDEX IF NOT EXISTS idx_picks_status ON picks(status);
CREATE INDEX IF NOT EXISTS idx_picks_sport ON picks(sport);
CREATE INDEX IF NOT EXISTS idx_picks_event_date ON picks(event_date);
