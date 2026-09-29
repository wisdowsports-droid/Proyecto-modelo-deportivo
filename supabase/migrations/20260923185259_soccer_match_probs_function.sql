-- Mismo modelo Poisson de picks_engine/models/soccer.py, portado a SQL para
-- poder recalcular 1X2 en lote sin gastar cuota de API (los goles esperados
-- ya salen de datos que tenemos: team_strengths + league_goal_baselines).
create or replace function soccer_match_probs(lam_home numeric, lam_away numeric, max_goals int default 10)
returns table(home_win numeric, draw_prob numeric, away_win numeric) language plpgsql immutable as $$
declare
  i int; j int; k int;
  p_i double precision; p_j double precision; p double precision;
  total double precision := 0;
  home_p double precision := 0; draw_p double precision := 0; away_p double precision := 0;
  fact double precision;
  lh double precision := lam_home; la double precision := lam_away;
begin
  for i in 0..max_goals loop
    fact := 1;
    for k in 2..i loop fact := fact * k; end loop;
    p_i := exp(-lh) * lh^i / fact;
    for j in 0..max_goals loop
      fact := 1;
      for k in 2..j loop fact := fact * k; end loop;
      p_j := exp(-la) * la^j / fact;
      p := p_i * p_j;
      total := total + p;
      if i > j then home_p := home_p + p;
      elsif i = j then draw_p := draw_p + p;
      else away_p := away_p + p;
      end if;
    end loop;
  end loop;
  return query select (home_p/total)::numeric, (draw_p/total)::numeric, (away_p/total)::numeric;
end;
$$;
