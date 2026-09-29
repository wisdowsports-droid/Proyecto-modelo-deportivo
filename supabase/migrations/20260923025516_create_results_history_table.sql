-- Historial de resultados terminados, usado por picks_engine (Python, corre
-- fuera de Supabase) para calibrar los modelos (fuerzas de ataque/defensa
-- en futbol, ratings Elo en el resto). Nunca se expone al front -- es
-- insumo interno para el calculo, no para mostrar.

CREATE TABLE IF NOT EXISTS results_history (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    external_id   TEXT UNIQUE,
    sport         TEXT NOT NULL,
    league        TEXT NOT NULL,
    match_date    TIMESTAMPTZ NOT NULL,
    home_team     TEXT NOT NULL,
    away_team     TEXT NOT NULL,
    home_score    INTEGER NOT NULL,
    away_score    INTEGER NOT NULL,
    source        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_results_history_sport_league ON results_history(sport, league);
CREATE INDEX IF NOT EXISTS idx_results_history_teams ON results_history(home_team, away_team);

ALTER TABLE results_history ENABLE ROW LEVEL SECURITY;

-- Sin politica de SELECT para anon/authenticated: esta tabla es insumo
-- interno del modelo, no un dato que el front deba consultar. Solo
-- accesible via esta conexion MCP / service role.
