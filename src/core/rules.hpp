#pragma once

#include "core/card.hpp"

#include <optional>

namespace baloot {

enum class game_mode {
  sun,
  hukum,
};

enum class buy_kind {
  bas,
  sun,
  hukum,
  ashkal,
  gablak_sun,
  gablak_ashkal,
  bet_open,
  bet_close,
  bet_double,
  bet_triple,
  bet_quadruple,
  gahwa,
  enforce_sun,
  enforce_hukum,
};

enum class team_id {
  a,
  b,
};

struct rules_config {
  int target_score = 152;
  int last_trick_bonus = 10;
  int baloot_bonus = 2;
  int max_void_games = 24;
};

std::string to_string(game_mode mode);
std::string to_string(buy_kind kind);
std::string to_string(team_id team);

std::optional<game_mode> parse_game_mode(std::string_view value);
std::optional<buy_kind> parse_buy_kind(std::string_view value);
std::optional<team_id> parse_team_id(std::string_view value);

int sun_points(card value);
int hukum_points(card value, suit trump);
int card_points(card value, game_mode mode, std::optional<suit> trump);

int sun_strength(rank value);
int hukum_trump_strength(rank value);
int card_strength(card value, game_mode mode, std::optional<suit> trump);

bool is_trump(card value, game_mode mode, std::optional<suit> trump);

}  // namespace baloot
