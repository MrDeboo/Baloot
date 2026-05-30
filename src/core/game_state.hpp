#pragma once

#include "core/cards.hpp"
#include "core/project.hpp"
#include "core/rules.hpp"

#include <array>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace baloot {

enum class seat_role {
  initiator = 0,
  nitwit = 1,
  cutter = 2,
  dealer = 3,
};

struct buy_call {
  int actor_id{};
  buy_kind kind{buy_kind::bas};
  int phase{1};
  std::optional<suit> trump;
};

struct contract {
  game_mode mode{game_mode::sun};
  std::optional<suit> trump;
  int buyer_id{};
  int taker_id{};
  team_id buyer_team{team_id::a};
  buy_kind source_call{buy_kind::sun};
  int multiplier{1};
  bool closed{};
  bool ashkal{};
  bool gahwa{};
};

struct trick_play {
  int actor_id{};
  card played{};
  bool ikkah{};
  bool baloot{};
};

struct round {
  int leader_id{};
  std::vector<trick_play> plays;
  int winner_id{};
  int points{};
};

struct game_result {
  int team_a_points{};
  int team_b_points{};
  int team_a_card_points{};
  int team_b_card_points{};
  team_id winner{team_id::a};
  bool forfeited{};
  std::optional<team_id> forfeiting_team;
  std::string message;
};

struct sakkah_result {
  int team_a_score{};
  int team_b_score{};
  int games_played{};
  team_id winner{team_id::a};
  std::vector<std::string> log;
};

}  // namespace baloot
