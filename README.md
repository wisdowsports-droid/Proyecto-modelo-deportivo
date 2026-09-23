# picks-engine

Motor de picks multi-deporte para la "prueba en papel" de Steven. Reemplaza
el tracking manual en un Claude Doc (2 tandas, 15 picks, sin modelo real
detrás de la mayoría de los números) por: modelos estadísticos por deporte,
de-vig de cuotas, cálculo de valor (edge/Kelly), y una base de datos que
permite evaluar con métricas reales en vez de contar aciertos a ojo.

## Por qué existe esto

La tanda anterior (documentada en el Claude Doc) tenía dos problemas de
fondo, no solo mala suerte:

1. **Las "prob. modelo" no venían de un modelo.** Eran números puestos a
   mano, así que el "edge" calculado contra la cuota de mercado no era una
   ventaja real, era la ilusión de una.
2. **8-15 picks es una muestra demasiado chica para juzgar nada.** Ni un
   algoritmo bueno se distingue de uno malo con esa cantidad de datos.

Este proyecto ataca lo primero (modelos reales, no números inventados) y
deja la infraestructura para atacar lo segundo (una base de datos que
acumula picks graded en vez de perderse en un doc). No resuelve lo segundo
por sí solo — eso necesita volumen, que solo se consigue usándolo por un
tiempo.

## Arquitectura

```
picks_engine/
  market/devig.py       Cuotas -> probabilidad justa (sin margen de casa)
  models/
    elo.py               Motor Elo genérico (usado por tenis/NBA/NFL/MLB)
    _margin_elo.py        Base compartida para deportes con margen (NBA/NFL/MLB)
    soccer.py             Poisson de goles (fútbol) — da 1X2, doble oportunidad, over/under, BTTS
    tennis.py              Elo con mezcla por superficie + K dinámico
    basketball.py           NBA: Elo + multiplicador de margen de victoria
    football.py              NFL: igual, otras constantes
    baseball.py               MLB: igual, constantes mucho más conservadoras
  valuation/ev.py        Edge (modelo vs mercado) + stake sugerido (Kelly fraccionado)
  tracking/
    db.py                 SQLite: una fila por pick, de creación a resultado
    schema.sql
  evaluation/metrics.py   Brier score, log-loss, calibración, ROI en papel
tests/                    62 tests, unittest puro (sin pytest, ver abajo)
data/seed_picks.csv       Los 15 picks originales del doc
scripts/
  seed_from_legacy.py      Importa data/seed_picks.csv a la DB
  example_end_to_end.py     Ejemplo completo: fit -> devig -> edge -> log -> settle -> evaluate
```

Cada módulo tiene su propio docstring explicando las decisiones de diseño y,
más importante, **qué simplificaciones tiene** — léelos, no son solo
comentarios de relleno.

## Instalar y correr

```bash
pip install -r requirements.txt   # solo scipy; todo lo demás es librería estándar
python3 -m unittest discover -s tests -v   # 62 tests
python3 scripts/seed_from_legacy.py         # importa los 15 picks históricos a picks.db
python3 scripts/example_end_to_end.py       # pipeline completo de punta a punta
```

No usé `pytest` porque este sandbox no tiene acceso a PyPI en este momento
(bloqueo de red del entorno, no una decisión de diseño) — los tests están en
`unittest` puro de la librería estándar, que corre igual sin instalar nada
extra. Si tu máquina sí tiene acceso a PyPI, `pip install pytest` y
`pytest tests/` funciona sin tocar el código.

## Lo que SÍ hace cada pieza

- **`market/devig.py`**: convierte cuotas a probabilidad "justa" quitando
  el margen de la casa. Implementa dos métodos: multiplicativo (estándar) y
  Shin (1992), que corrige el sesgo favorito-perdedor (las casas no reparten
  el margen parejo entre favoritos y perdedores largos — Shin lo modela).
  Verificado con tests: para el mercado real Arsenal 1.08/12.00/34.00 del
  doc, Shin le da más probabilidad al favorito que el método multiplicativo,
  como se espera.

- **`models/elo.py` + `_margin_elo.py`**: Elo genérico con ventaja de local
  y multiplicador de margen de victoria estilo FiveThirtyEight (un
  triunfo por goleada mueve el rating más que uno ajustado, pero se
  amortigua si el favorito "debía" ganar así).

- **`models/soccer.py`**: Poisson de goles con fuerzas de ataque/defensa por
  equipo (aproximación por promedios, no MLE completo — ver
  "Limitaciones"). De un solo fit salen 1X2, doble oportunidad, over/under y
  ambos anotan — los 4 mercados que usó la tanda de Champions Femenina +
  Colombia, desde un solo modelo.

- **`models/tennis.py`**: Elo con mezcla overall/superficie y K dinámico
  (jugadores nuevos se mueven rápido, veteranos lento — como Glicko pero
  más barato de calcular).

- **`models/basketball.py`, `football.py`, `baseball.py`**: mismo núcleo
  Elo-con-margen, constantes distintas por deporte (K y ventaja de local).
  MLB usa constantes mucho más conservadoras porque el resultado de un solo
  partido de béisbol es muy ruidoso (hasta el mejor equipo pierde ~35-40%
  de sus partidos en una temporada).

- **`valuation/ev.py`**: edge = prob. modelo − prob. justa de mercado;
  Kelly fraccionado (cuarto de Kelly por defecto) para no apostar como si
  el modelo fuera perfecto.

- **`tracking/db.py`**: SQLite con una tabla `picks`. `add_pick` →
  `settle_pick` → `graded_picks_for_evaluation` (excluye a propósito los
  picks legacy sin modelo real y los que no tienen resultado aún).

- **`evaluation/metrics.py`**: Brier score y log-loss (calibración, no
  "cuántos acerté"), bins de calibración, y ROI en unidades de papel. Marca
  explícitamente `reliable=False` mientras haya menos de 100 picks graded
  — la muestra chica sigue siendo chica aunque el código ahora sea serio.

## Limitaciones (léelo antes de confiar en esto)

Esto es v1: modelos correctos y probados, pero **sin datos históricos
reales conectados todavía**. Específicamente:

- **No hay feed de cuotas en vivo ni de resultados históricos.** Los
  modelos funcionan con cualquier lista de partidos que les pases, pero no
  van a buscar esos partidos solos. Necesitas conectar una fuente por
  deporte (opciones reales más abajo).
- **Fútbol**: las fuerzas de equipo se calculan por promedios simples, no
  por el ajuste de máxima verosimilitud (MLE) del paper original de
  Dixon-Coles. Es una aproximación razonable, no la versión más precisa
  posible. `rho` (la corrección de marcadores bajos) está en 0 por defecto
  porque ajustarlo también necesita el mismo dataset histórico.
- **Tenis**: las constantes de K y el peso de superficie son valores de
  partida documentados públicamente (estilo FiveThirtyEight/Tennis
  Abstract), no calibrados contra historial real de ATP/WTA.
- **NBA/NFL**: no incluye ajuste por descanso/viajes (NBA) ni por cambio de
  quarterback titular (NFL) — este último es probablemente el factor
  individual más importante en NFL y no está modelado.
- **MLB**: no incluye ajuste por pitcher abridor, que en béisbol pesa
  muchísimo más que cualquier otro factor de equipo. Esta es la brecha más
  grande de las cinco.
- **15-30-50 picks siguen sin ser suficientes.** El código ahora mide
  calibración de verdad, pero calibración de verdad necesita ~100+ picks
  graded para decir algo. `evaluate_picks` marca esto explícitamente
  (`reliable=False`) en vez de fingir una conclusión.

Ninguna de estas es un secreto escondido — cada una está documentada en el
docstring del módulo correspondiente, con la razón de por qué se dejó así
en esta versión.

## Próximos pasos sugeridos (en orden de impacto)

1. **Conectar un feed de cuotas real** — sin esto, todo lo demás es teoría.
   Opciones con tier gratis/barato: [The Odds API](https://the-odds-api.com/)
   cubre fútbol, tenis, NBA, NFL y MLB con una sola integración.
2. **Conectar datos históricos por deporte** para fitear modelos de verdad:
   - Fútbol: `football-data.org` o API-FOOTBALL (ligas colombianas y
     europeas, incluida Champions Femenina).
   - Tenis: los CSV públicos de Jeff Sackmann en GitHub (`tennis_atp`,
     `tennis_wta`) — es lo que usa buena parte de la comunidad de Elo de
     tenis.
   - NBA: `nba_api` (oficial, gratis) o `balldontlie`.
   - NFL: `nfl_data_py`.
   - MLB: `pybaseball` (scrapea Baseball Reference/FanGraphs/Statcast).
3. **Fit MLE real para el modelo de fútbol** (Dixon-Coles completo con
   `scipy.optimize.minimize` sobre la log-verosimilitud) en vez de la
   aproximación por promedios actual.
4. **Ajuste por pitcher abridor (MLB)** y **por QB titular (NFL)** — las
   dos brechas de mayor impacto señaladas arriba.
5. **Seguir alimentando la DB con picks reales** (`add_pick` /
   `settle_pick`) hasta tener volumen suficiente para que
   `evaluate_picks` marque `reliable=True`.

## Los 15 picks originales

Ya importados en `data/seed_picks.csv` y cargables con
`scripts/seed_from_legacy.py`. Quedan marcados con `model_prob=NULL` a
propósito — nunca se van a mezclar con las métricas de evaluación del motor
nuevo, precisamente porque no vinieron de un modelo real (ver
`tracking/db.py`). Los dos picks de Colombia (Medellín-Jaguares,
Santa Fe-Cali) siguen `pending` porque los partidos no habían terminado al
momento de este corte.
