#include "core/card.hpp"

#include <algorithm>
#include <array>
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

std::string to_string(suit value) {
  switch (value) {
    case suit::clubs:
      return "C";
    case suit::diamonds:
      return "D";
    case suit::hearts:
      return "H";
    case suit::spades:
      return "S";
  }
  return "?";
}

std::string to_string(rank value) {
  switch (value) {
    case rank::seven:
      return "7";
    case rank::eight:
      return "8";
    case rank::nine:
      return "9";
    case rank::ten:
      return "10";
    case rank::jack:
      return "J";
    case rank::queen:
      return "Q";
    case rank::king:
      return "K";
    case rank::ace:
      return "A";
  }
  return "?";
}

std::string to_string(card value) {
  return to_string(value.r) + to_string(value.s);
}

std::optional<suit> parse_suit(std::string_view value) {
  const auto token = upper(value);
  if (token == "C" || token == "CLUBS") return suit::clubs;
  if (token == "D" || token == "DIAMONDS") return suit::diamonds;
  if (token == "H" || token == "HEARTS") return suit::hearts;
  if (token == "S" || token == "SPADES") return suit::spades;
  return std::nullopt;
}

std::optional<rank> parse_rank(std::string_view value) {
  const auto token = upper(value);
  if (token == "7" || token == "SEVEN") return rank::seven;
  if (token == "8" || token == "EIGHT") return rank::eight;
  if (token == "9" || token == "NINE") return rank::nine;
  if (token == "10" || token == "T" || token == "TEN") return rank::ten;
  if (token == "J" || token == "JACK") return rank::jack;
  if (token == "Q" || token == "QUEEN") return rank::queen;
  if (token == "K" || token == "KING") return rank::king;
  if (token == "A" || token == "ACE") return rank::ace;
  return std::nullopt;
}

std::optional<card> parse_card(std::string_view value) {
  const auto token = upper(value);
  if (token.size() < 2) return std::nullopt;

  const auto suit_token = token.substr(token.size() - 1);
  auto parsed_suit = parse_suit(suit_token);
  if (!parsed_suit) return std::nullopt;

  const auto rank_token = token.substr(0, token.size() - 1);
  auto parsed_rank = parse_rank(rank_token);
  if (!parsed_rank) return std::nullopt;

  return card{*parsed_suit, *parsed_rank};
}

int rank_sequence_index(rank value) {
  switch (value) {
    case rank::seven:
      return 0;
    case rank::eight:
      return 1;
    case rank::nine:
      return 2;
    case rank::ten:
      return 3;
    case rank::jack:
      return 4;
    case rank::queen:
      return 5;
    case rank::king:
      return 6;
    case rank::ace:
      return 7;
  }
  return -1;
}

bool ranks_consecutive(rank low, rank high) {
  return rank_sequence_index(high) == rank_sequence_index(low) + 1;
}

}  // namespace baloot
