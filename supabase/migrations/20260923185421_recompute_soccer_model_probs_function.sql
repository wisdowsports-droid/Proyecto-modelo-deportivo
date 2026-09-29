create or replace function recompute_soccer_model_probs()
returns int language plpgsql as $$
declare
  updated_count int;
begin
  with matched as (
    select
      f.id,
      b.avg_home_goals * th.attack * ta.defense as lam_home,
      b.avg_away_goals * ta.attack * th.defense as lam_away
    from fixtures f
    join league_goal_baselines b on b.league = f.league
    join team_strengths th on th.league = f.league and th.team = match_team_strength(f.league, f.home_team)
    join team_strengths ta on ta.league = f.league and ta.team = match_team_strength(f.league, f.away_team)
    where f.sport='soccer' and f.status='scheduled'
  ),
  probs as (
    select m.id, mp.home_win, mp.draw_prob, mp.away_win
    from matched m, lateral soccer_match_probs(m.lam_home, m.lam_away) mp
  ),
  upd as (
    update fixtures f set
      model_prob_home = p.home_win,
      model_prob_draw = p.draw_prob,
      model_prob_away = p.away_win,
      model_updated_at = now()
    from probs p
    where f.id = p.id
    returning f.id
  )
  select count(*) into updated_count from upd;
  return updated_count;
end;
$$;
