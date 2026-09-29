create or replace function refit_team_strengths_from_history(target_leagues text[], min_games int default 3)
returns int language plpgsql as $$
declare
  updated_count int;
begin
  with baselines as (
    select r.league, avg(r.home_score)::numeric as avg_home_goals, avg(r.away_score)::numeric as avg_away_goals,
           (avg(r.home_score) + avg(r.away_score))/2.0 as avg_goals
    from results_history r
    where r.source = 'football-data.co.uk' and r.league = any(target_leagues)
    group by r.league
  ),
  team_matches as (
    select league, home_team as team, home_score as scored, away_score as conceded from results_history
    where source='football-data.co.uk' and league = any(target_leagues)
    union all
    select league, away_team as team, away_score as scored, home_score as conceded from results_history
    where source='football-data.co.uk' and league = any(target_leagues)
  ),
  team_agg as (
    select league, team, count(*) as played, avg(scored)::numeric as avg_scored, avg(conceded)::numeric as avg_conceded
    from team_matches group by league, team
    having count(*) >= min_games
  ),
  upsert_baselines as (
    insert into league_goal_baselines (league, avg_home_goals, avg_away_goals)
    select league, avg_home_goals, avg_away_goals from baselines
    on conflict (league) do update set avg_home_goals=excluded.avg_home_goals, avg_away_goals=excluded.avg_away_goals, fitted_at=now()
    returning 1
  ),
  upsert_teams as (
    insert into team_strengths (league, team, attack, defense)
    select ta.league, ta.team, ta.avg_scored/b.avg_goals, ta.avg_conceded/b.avg_goals
    from team_agg ta join baselines b on b.league = ta.league
    on conflict (league, team) do update set attack=excluded.attack, defense=excluded.defense, fitted_at=now()
    returning 1
  )
  select count(*) into updated_count from upsert_teams;
  return updated_count;
end;
$$;
