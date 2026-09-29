create or replace function refit_team_strengths_from_history(target_leagues text[], min_games int default 3)
returns int language plpgsql as $$
declare
  updated_count int;
begin
  with baselines as (
    select r.league,
           avg(r.home_score)::numeric as avg_home_goals, avg(r.away_score)::numeric as avg_away_goals,
           (avg(r.home_score) + avg(r.away_score))/2.0 as avg_goals,
           avg(r.home_corners)::numeric as avg_home_corners, avg(r.away_corners)::numeric as avg_away_corners,
           (avg(r.home_corners) + avg(r.away_corners))/2.0 as avg_corners,
           avg(coalesce(r.home_yellow,0) + coalesce(r.home_red,0))::numeric as avg_home_cards,
           avg(coalesce(r.away_yellow,0) + coalesce(r.away_red,0))::numeric as avg_away_cards,
           (avg(coalesce(r.home_yellow,0)+coalesce(r.home_red,0)) + avg(coalesce(r.away_yellow,0)+coalesce(r.away_red,0)))/2.0 as avg_cards
    from results_history r
    where r.source = 'football-data.co.uk' and r.league = any(target_leagues)
    group by r.league
  ),
  team_matches as (
    select league, home_team as team, home_score as scored, away_score as conceded,
           home_corners as corners_for, away_corners as corners_against,
           coalesce(home_yellow,0)+coalesce(home_red,0) as cards_for,
           coalesce(away_yellow,0)+coalesce(away_red,0) as cards_against
    from results_history
    where source='football-data.co.uk' and league = any(target_leagues)
    union all
    select league, away_team as team, away_score as scored, home_score as conceded,
           away_corners as corners_for, home_corners as corners_against,
           coalesce(away_yellow,0)+coalesce(away_red,0) as cards_for,
           coalesce(home_yellow,0)+coalesce(home_red,0) as cards_against
    from results_history
    where source='football-data.co.uk' and league = any(target_leagues)
  ),
  team_agg as (
    select league, team, count(*) as played,
           avg(scored)::numeric as avg_scored, avg(conceded)::numeric as avg_conceded,
           avg(corners_for)::numeric as avg_corners_for, avg(corners_against)::numeric as avg_corners_against,
           avg(cards_for)::numeric as avg_cards_for, avg(cards_against)::numeric as avg_cards_against
    from team_matches group by league, team
    having count(*) >= min_games
  ),
  upsert_baselines as (
    insert into league_goal_baselines (league, avg_home_goals, avg_away_goals, avg_home_corners, avg_away_corners, avg_home_cards, avg_away_cards)
    select league, avg_home_goals, avg_away_goals, avg_home_corners, avg_away_corners, avg_home_cards, avg_away_cards from baselines
    on conflict (league) do update set
      avg_home_goals=excluded.avg_home_goals, avg_away_goals=excluded.avg_away_goals,
      avg_home_corners=excluded.avg_home_corners, avg_away_corners=excluded.avg_away_corners,
      avg_home_cards=excluded.avg_home_cards, avg_away_cards=excluded.avg_away_cards,
      fitted_at=now()
    returning 1
  ),
  upsert_teams as (
    insert into team_strengths (league, team, attack, defense, corner_attack, corner_defense, card_attack, card_defense)
    select ta.league, ta.team,
           ta.avg_scored/b.avg_goals, ta.avg_conceded/b.avg_goals,
           ta.avg_corners_for/nullif(b.avg_corners,0), ta.avg_corners_against/nullif(b.avg_corners,0),
           ta.avg_cards_for/nullif(b.avg_cards,0), ta.avg_cards_against/nullif(b.avg_cards,0)
    from team_agg ta join baselines b on b.league = ta.league
    on conflict (league, team) do update set
      attack=excluded.attack, defense=excluded.defense,
      corner_attack=excluded.corner_attack, corner_defense=excluded.corner_defense,
      card_attack=excluded.card_attack, card_defense=excluded.card_defense,
      fitted_at=now()
    returning 1
  )
  select count(*) into updated_count from upsert_teams;
  return updated_count;
end;
$$;
