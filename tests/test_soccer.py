import unittest

from picks_engine.models.soccer import SoccerPoissonModel, TeamStrength, fit_team_strengths


class TestMatchProbabilities(unittest.TestCase):
    def setUp(self):
        self.model = SoccerPoissonModel(
            league_avg_home_goals=1.5,
            league_avg_away_goals=1.1,
            strengths={
                "Strong": TeamStrength(attack=1.4, defense=0.7),
                "Weak": TeamStrength(attack=0.6, defense=1.3),
            },
        )

    def test_probabilities_sum_to_one(self):
        p = self.model.match_probabilities("Strong", "Weak")
        self.assertAlmostEqual(p["home_win"] + p["draw"] + p["away_win"], 1.0, places=6)

    def test_double_chance_is_sum_of_its_parts(self):
        p = self.model.match_probabilities("Strong", "Weak")
        self.assertAlmostEqual(p["double_chance_1x"], p["home_win"] + p["draw"], places=6)
        self.assertAlmostEqual(p["double_chance_x2"], p["draw"] + p["away_win"], places=6)
        self.assertAlmostEqual(p["double_chance_12"], p["home_win"] + p["away_win"], places=6)

    def test_strong_team_favored_at_home(self):
        p = self.model.match_probabilities("Strong", "Weak")
        self.assertGreater(p["home_win"], p["away_win"])

    def test_unknown_teams_use_default_strength(self):
        # two unknown teams should be a coinflip-ish match (home advantage
        # from league_avg_home_goals > league_avg_away_goals still applies)
        p = self.model.match_probabilities("Mystery FC", "Unknown United")
        self.assertGreater(p["home_win"], p["away_win"])

    def test_over_under_sums_to_one(self):
        ou = self.model.over_under("Strong", "Weak", line=2.5)
        self.assertAlmostEqual(ou["over"] + ou["under"], 1.0, places=6)

    def test_btts_sums_to_one(self):
        bts = self.model.both_teams_to_score("Strong", "Weak")
        self.assertAlmostEqual(bts["yes"] + bts["no"], 1.0, places=6)


class TestFitTeamStrengths(unittest.TestCase):
    def test_requires_matches(self):
        with self.assertRaises(ValueError):
            fit_team_strengths([])

    def test_dominant_team_gets_attack_above_one(self):
        matches = [
            ("A", "B", 3, 0),
            ("B", "A", 0, 2),
            ("A", "C", 2, 1),
            ("C", "A", 0, 3),
            ("B", "C", 1, 1),
            ("C", "B", 1, 1),
        ]
        model = fit_team_strengths(matches)
        self.assertGreater(model.strengths["A"].attack, model.strengths["B"].attack)
        self.assertGreater(model.strengths["A"].attack, model.strengths["C"].attack)

    def test_league_averages_are_plausible(self):
        matches = [("A", "B", 2, 1), ("B", "A", 1, 1)]
        model = fit_team_strengths(matches)
        self.assertAlmostEqual(model.league_avg_home_goals, 1.5)
        self.assertAlmostEqual(model.league_avg_away_goals, 1.0)


if __name__ == "__main__":
    unittest.main()
