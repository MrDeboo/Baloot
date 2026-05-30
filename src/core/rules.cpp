#include "core/rules.hpp"

#include <algorithm>
#include <cctype>

namespace baloot {
namespace {

std::string upper(std::string_view value) {
  std::string out(value);
  std::ranges::transform(out, out.begin(), [](unsigned char ch) {
    return static_cast<char>(std::toupper(ch));
  });
  return out;
}

}  // namespace

std::string to_string(game_mode mode) {
  switch (mode) {
    case game_mode::sun:
      return "SUN";
    case game_mode::hukum:
      return "HUKUM";
  }
  return "UNKNOWN";
}

std::string to_string(buy_kind kind) {
  switch (kind) {
    case buy_kind::bas:
      return "BAS";
    case buy_kind::sun:
      return "SUN";
    case buy_kind::hukum:
      return "HUKUM";
    case buy_kind::ashkal:
      return "ASHKAL";
    case buy_kind::gablak_sun:
      return "GABLAK_SUN";
    case buy_kind::gablak_ashkal:
      return "GABLAK_ASHKAL";
    case buy_kind::bet_open:
      return "BET_OPEN";
    case buy_kind::bet_close:
      return "BET_CLOSE";
    case buy_kind::bet_double:
      return "BET_DOUBLE";
    case buy_kind::bet_triple:
      return "BET_TRIPLE";
    case buy_kind::bet_quadruple:
      return "BET_QUADRUPLE";
    case buy_kind::gahwa:
      return "GAHWA";
    case buy_kind::enforce_sun:
      return "ENFORCE_SUN";
    case buy_kind::enforce_hukum:
      return "ENFORCE_HUKUM";
  }
  return "UNKNOWN";
}

std::string to_string(team_id team) {
  return team == team_id::a ? "A" : "B";
}

std::optional<game_mode> parse_game_mode(std::string_view value) {
  const auto token = upper(value);
  if (token == "SUN" || token == "ASHKAL") return game_mode::sun;
  if (token == "HUKUM") return game_mode::hukum;
  return std::nullopt;
}

std::optional<buy_kind> parse_buy_kind(std::string_view value) {
  const auto token = upper(value);
  if (token == "BAS") return buy_kind::bas;
  if (token == "SUN") return buy_kind::sun;
  if (token == "HUKUM") return buy_kind::hukum;
  if (token == "ASHKAL") return buy_kind::ashkal;
  if (token == "GABLAK_SUN") return buy_kind::gablak_sun;
  if (token == "GABLAK_ASHKAL") return buy_kind::gablak_ashkal;
  if (token == "BET_OPEN") return buy_kind::bet_open;
  if (token == "BET_CLOSE") return buy_kind::bet_close;
  if (token == "BET_DOUBLE" || token == "DOUBLE") return buy_kind::bet_double;
  if (token == "BET_TRIPLE" || token == "TRIPLE") return buy_kind::bet_triple;
  if (token == "BET_QUADRUPLE" || token == "QUADRUPLE") return buy_kind::bet_quadruple;
  if (token == "GAHWA" || token == "QAHWA") return buy_kind::gahwa;
  if (token == "ENFORCE_SUN") return buy_kind::enforce_sun;
  if (token == "ENFORCE_HUKUM") return buy_kind::enforce_hukum;
  return std::nullopt;
}

std::optional<team_id> parse_team_id(std::string_view value) {
  const auto token = upper(value);
  if (token == "A") return team_id::a;
  if (token == "B") return team_id::b;
  return std::nullopt;
}

int sun_points(card value) {
  switch (value.r) {
    case rank::ace:
      return 11;
    case rank::ten:
      return 10;
    case rank::king:
      return 4;
    case rank::queen:
      return 3;
    case rank::jack:
      return 2;
    case rank::nine:
    case rank::eight:
    case rank::seven:
      return 0;
  }
  return 0;
}

int hukum_points(card value, suit trump) {
  if (value.s != trump) return sun_points(value);
  switch (value.r) {
    case rank::jack:
      return 20;
    case rank::nine:
      return 14;
    case rank::ace:
      return 11;
    case rank::ten:
      return 10;
    case rank::king:
      return 4;
    case rank::queen:
      return 3;
    case rank::eight:
    case rank::seven:
      return 0;
  }
  return 0;
}

int card_points(card value, game_mode mode, std::optional<suit> trump) {
  if (mode == game_mode::hukum && trump) {
    return hukum_points(value, *trump);
  }
  return sun_points(value);
}

int sun_strength(rank value) {
  switch (value) {
    case rank::ace:
      return 8;
    case rank::ten:
      return 7;
    case rank::king:
      return 6;
    case rank::queen:
      return 5;
    case rank::jack:
      return 4;
    case rank::nine:
      return 3;
    case rank::eight:
      return 2;
    case rank::seven:
      return 1;
  }
  return 0;
}

int hukum_trump_strength(rank value) {
  switch (value) {
    case rank::jack:
      return 8;
    case rank::nine:
      return 7;
    case rank::ace:
      return 6;
    case rank::ten:
      return 5;
    case rank::king:
      return 4;
    case rank::queen:
      return 3;
    case rank::eight:
      return 2;
    case rank::seven:
      return 1;
  }
  return 0;
}

int card_strength(card value, game_mode mode, std::optional<suit> trump) {
  if (mode == game_mode::hukum && trump && value.s == *trump) {
    return hukum_trump_strength(value.r);
  }
  return sun_strength(value.r);
}

bool is_trump(card value, game_mode mode, std::optional<suit> trump) {
  return mode == game_mode::hukum && trump && value.s == *trump;
}

}  // namespace baloot
