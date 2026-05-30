#pragma once

#include "core/game_state.hpp"

#include <functional>
#include <optional>

namespace baloot {

struct trick_context {
  game_mode mode{game_mode::sun};
  std::optional<suit> trump;
  bool closed{};
  int player_id{};
  std::function<team_id(int)> team_of;
  std::vector<trick_play> plays;
};

int winning_play_index(const std::vector<trick_play>& plays, game_mode mode,
                       std::optional<suit> trump);
int trick_points(const std::vector<trick_play>& plays, game_mode mode,
                 std::optional<suit> trump);
cards legal_cards(const cards& hand, const trick_context& context);
void validate_play_or_throw(const cards& hand, card played,
                            const trick_context& context);

int rounded_hukum_game_points(int card_points);
int rounded_sun_game_points(int card_points);

game_result score_completed_game(const contract& contract,
                                 int team_a_card_points,
                                 int team_b_card_points,
                                 int team_a_bonus_points,
                                 int team_b_bonus_points,
                                 const rules_config& rules);

}  // namespace baloot
