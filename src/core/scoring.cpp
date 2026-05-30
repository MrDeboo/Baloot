#include "core/scoring.hpp"

#include "core/gaid.hpp"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <sstream>

namespace baloot {
namespace {

bool beats(card challenger, card current, suit led, game_mode mode,
           std::optional<suit> trump) {
  const auto challenger_trump = is_trump(challenger, mode, trump);
  const auto current_trump = is_trump(current, mode, trump);
  if (challenger_trump != current_trump) return challenger_trump;
  if (challenger.s != current.s) {
    if (challenger.s == led) return true;
    if (current.s == led) return false;
    return false;
  }
  return card_strength(challenger, mode, trump) > card_strength(current, mode, trump);
}

cards cards_matching(const cards& hand, auto predicate) {
  std::vector<card> out;
  for (auto value : hand.values()) {
    if (predicate(value)) out.push_back(value);
  }
  return cards(out);
}

bool contains_any(const cards& hand, auto predicate) {
  return std::ranges::any_of(hand.values(), predicate);
}

cards higher_trumps_than(const cards& hand, card current_high,
                         std::optional<suit> trump) {
  if (!trump) return cards{};
  return cards_matching(hand, [&](card value) {
    return value.s == *trump && card_strength(value, game_mode::hukum, trump) >
                                   card_strength(current_high, game_mode::hukum, trump);
  });
}

}  // namespace

int winning_play_index(const std::vector<trick_play>& plays, game_mode mode,
                       std::optional<suit> trump) {
  if (plays.empty()) return -1;
  const auto led = plays.front().played.s;
  int winner = 0;
  for (std::size_t i = 1; i < plays.size(); ++i) {
    if (beats(plays[i].played, plays[static_cast<std::size_t>(winner)].played, led,
              mode, trump)) {
      winner = static_cast<int>(i);
    }
  }
  return winner;
}

int trick_points(const std::vector<trick_play>& plays, game_mode mode,
                 std::optional<suit> trump) {
  int total = 0;
  for (auto play : plays) {
    total += card_points(play.played, mode, trump);
  }
  return total;
}

cards legal_cards(const cards& hand, const trick_context& context) {
  if (hand.empty()) return cards{};
  if (context.plays.empty()) {
    if (context.mode == game_mode::hukum && context.closed && context.trump &&
        contains_any(hand, [&](card value) { return value.s != *context.trump; })) {
      return cards_matching(hand, [&](card value) { return value.s != *context.trump; });
    }
    return hand;
  }

  const auto led_suit = context.plays.front().played.s;
  auto follow = cards_matching(hand, [&](card value) { return value.s == led_suit; });
  if (!follow.empty()) {
    if (context.mode == game_mode::hukum && context.trump && led_suit == *context.trump) {
      const auto winner_index =
          winning_play_index(context.plays, context.mode, context.trump);
      const auto& winning = context.plays[static_cast<std::size_t>(winner_index)];
      if (context.team_of &&
          context.team_of(winning.actor_id) != context.team_of(context.player_id)) {
        auto higher = higher_trumps_than(follow, winning.played, context.trump);
        if (!higher.empty()) return higher;
      }
    }
    return follow;
  }

  if (context.mode != game_mode::hukum || !context.trump) {
    return hand;
  }

  const auto trumps = cards_matching(hand, [&](card value) { return value.s == *context.trump; });
  if (trumps.empty()) return hand;

  const auto winner_index = winning_play_index(context.plays, context.mode, context.trump);
  const auto& winning = context.plays[static_cast<std::size_t>(winner_index)];
  const auto current_side_winning =
      context.team_of && context.team_of(winning.actor_id) == context.team_of(context.player_id);
  const auto player_position = static_cast<int>(context.plays.size()) + 1;

  if (current_side_winning && player_position == 4) return hand;

  const auto partner_ikkah =
      current_side_winning && player_position == 3 &&
      std::ranges::any_of(context.plays, [&](const trick_play& play) {
        return play.ikkah && context.team_of &&
               context.team_of(play.actor_id) == context.team_of(context.player_id);
      });
  if (partner_ikkah) return hand;

  if (is_trump(winning.played, context.mode, context.trump)) {
    if (context.team_of &&
        context.team_of(winning.actor_id) != context.team_of(context.player_id)) {
      auto higher = higher_trumps_than(trumps, winning.played, context.trump);
      if (!higher.empty()) return higher;
      if (player_position == 3) return hand;
    }
  }

  return trumps;
}

void validate_play_or_throw(const cards& hand, card played,
                            const trick_context& context) {
  if (!hand.contains(played)) {
    throw invalid_action(context.player_id, "played card is not in hand");
  }
  auto legal = legal_cards(hand, context);
  if (legal.contains(played)) return;

  if (context.plays.empty()) {
    throw trump_initiation(context.player_id, played, std::move(legal),
                           "closed Hukum forbids leading trump while holding non-trump");
  }

  const auto led_suit = context.plays.front().played.s;
  if (contains_any(hand, [&](card value) { return value.s == led_suit; }) &&
      played.s != led_suit) {
    throw invalid_cut(context.player_id, played, std::move(legal),
                      "player had to follow the led suit");
  }

  if (context.mode == game_mode::hukum && context.trump) {
    const auto has_trump =
        contains_any(hand, [&](card value) { return value.s == *context.trump; });
    if (has_trump && played.s != *context.trump && !legal.empty()) {
      throw didnt_knock(context.player_id, played, std::move(legal),
                        "player had to knock with trump");
    }
    if (played.s == *context.trump && !legal.empty()) {
      throw didnt_go_higher(context.player_id, played, std::move(legal),
                            "player had to play a higher trump");
    }
  }

  throw invalid_action(context.player_id, "illegal card play");
}

int rounded_hukum_game_points(int card_points_value) {
  const auto remainder = card_points_value % 10;
  auto rounded = card_points_value - remainder;
  if (remainder > 5) rounded += 10;
  return rounded / 10;
}

int rounded_sun_game_points(int card_points_value) {
  const auto remainder = card_points_value % 10;
  if (remainder == 5) return card_points_value / 5;
  auto rounded = card_points_value - remainder;
  if (remainder > 5) rounded += 10;
  return rounded / 5;
}

game_result score_completed_game(const contract& contract_value,
                                 int team_a_card_points,
                                 int team_b_card_points,
                                 int team_a_bonus_points,
                                 int team_b_bonus_points,
                                 const rules_config& rules) {
  const auto total_card_units = contract_value.mode == game_mode::hukum ? 16 : 26;
  const auto declarer_team = contract_value.buyer_team;

  int team_a_game = contract_value.mode == game_mode::hukum
                        ? rounded_hukum_game_points(team_a_card_points)
                        : rounded_sun_game_points(team_a_card_points);
  int team_b_game = total_card_units - team_a_game;

  if (team_a_card_points == 0 || team_b_card_points == 0) {
    if (team_a_card_points > team_b_card_points) {
      team_a_game = contract_value.mode == game_mode::hukum ? 25 : 44;
      team_b_game = 0;
    } else {
      team_a_game = 0;
      team_b_game = contract_value.mode == game_mode::hukum ? 25 : 44;
    }
  }

  team_a_game += team_a_bonus_points;
  team_b_game += team_b_bonus_points;

  const auto declarer_points =
      declarer_team == team_id::a ? team_a_game : team_b_game;
  const auto opponent_points =
      declarer_team == team_id::a ? team_b_game : team_a_game;
  const auto declarer_made = declarer_points >= opponent_points;

  game_result result;
  result.team_a_card_points = team_a_card_points;
  result.team_b_card_points = team_b_card_points;
  result.winner =
      team_a_game >= team_b_game ? team_id::a : team_id::b;

  if (contract_value.multiplier == 1) {
    if (declarer_made) {
      result.team_a_points = team_a_game;
      result.team_b_points = team_b_game;
    } else if (declarer_team == team_id::a) {
      result.team_a_points = 0;
      result.team_b_points = team_a_game + team_b_game;
      result.winner = team_id::b;
    } else {
      result.team_a_points = team_a_game + team_b_game;
      result.team_b_points = 0;
      result.winner = team_id::a;
    }
  } else {
    const auto whole = (team_a_game + team_b_game) * contract_value.multiplier;
    if (team_a_game >= team_b_game) {
      result.team_a_points = whole;
      result.team_b_points = 0;
      result.winner = team_id::a;
    } else {
      result.team_a_points = 0;
      result.team_b_points = whole;
      result.winner = team_id::b;
    }
  }

  if (contract_value.gahwa) {
    if (result.winner == team_id::a) {
      result.team_a_points = rules.target_score;
      result.team_b_points = 0;
    } else {
      result.team_a_points = 0;
      result.team_b_points = rules.target_score;
    }
  }

  return result;
}

}  // namespace baloot
