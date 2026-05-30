#pragma once

#include <optional>
#include <string>
#include <string_view>

namespace baloot {

enum class suit {
  clubs,
  diamonds,
  hearts,
  spades,
};

enum class rank {
  seven,
  eight,
  nine,
  ten,
  jack,
  queen,
  king,
  ace,
};

struct card {
  suit s{};
  rank r{};

  friend auto operator<=>(const card&, const card&) = default;
};

std::string to_string(suit value);
std::string to_string(rank value);
std::string to_string(card value);

std::optional<suit> parse_suit(std::string_view value);
std::optional<rank> parse_rank(std::string_view value);
std::optional<card> parse_card(std::string_view value);

int rank_sequence_index(rank value);
bool ranks_consecutive(rank low, rank high);

}  // namespace baloot
