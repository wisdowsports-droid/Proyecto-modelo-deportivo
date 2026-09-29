-- Partidos del dia/próximos con cuotas en vivo + probabilidades calculadas
-- por picks_engine. Se llena por: 1) una Edge Function que trae fixtures+
-- cuotas de un feed externo (The Odds API), 2) un job que corre los modelos
-- de picks_engine y escribe model_prob_home/draw/away sobre esas filas.
-- Lectura pública (para el front de Lovable); escritura solo desde
-- contextos de confianza (esta conexión MCP, la Edge Function, o
-- picks_engine con la service key).

CREATE TABLE IF NOT EXISTS fixtures (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    external_id         TEXT UNIQUE,              -- id del partido en el feed externo (para upsert sin duplicar)
    sport               TEXT NOT NULL,            -- 'soccer' | 'tennis' | 'basketball' | 'football' | 'baseball'
    league              TEXT NOT NULL,             -- 'NBA', 'Premier League', 'ATP', ...
    home_team           TEXT NOT NULL,
    away_team           TEXT NOT NULL,
    commence_time        TIMESTAMPTZ NOT NULL,      -- kickoff/inicio, en UTC

    -- cuotas de mercado (mejor disponible / consenso), crudas del feed
    odds_home           NUMERIC,
    odds_draw            NUMERIC,                   -- NULL en deportes sin empate (tenis, NBA, NFL, MLB)
    odds_away            NUMERIC,
    odds_updated_at       TIMESTAMPTZ,

    -- probabilidades del modelo (picks_engine), ya sin vig
    model_prob_home        NUMERIC,
    model_prob_draw         NUMERIC,
    model_prob_away         NUMERIC,
    model_updated_at         TIMESTAMPTZ,

    status                TEXT NOT NULL DEFAULT 'scheduled'
                            CHECK (status IN ('scheduled','live','finished','postponed','cancelled')),
    home_score              INTEGER,
    away_score               INTEGER,

    created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fixtures_sport ON fixtures(sport);
CREATE INDEX IF NOT EXISTS idx_fixtures_commence_time ON fixtures(commence_time);
CREATE INDEX IF NOT EXISTS idx_fixtures_status ON fixtures(status);

ALTER TABLE fixtures ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read access" ON fixtures
    FOR SELECT
    TO anon, authenticated
    USING (true);

-- Sin políticas de insert/update/delete para anon/authenticated a propósito:
-- el front de Lovable es de solo lectura sobre esta tabla. Las escrituras
-- vienen de la Edge Function (service role) o de esta conexión MCP.
