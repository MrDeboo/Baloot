#include "core/cards.hpp"

#include <algorithm>
#include <sstream>
#include <stdexcept>

namespace baloot {

cards::cards(std::vector<card> values) : values_(std::move(values)) {}

std::size_t cards::size() const {
  return values_.size();
}

bool cards::empty() const {
  return values_.empty();
}

bool cards::contains(card value) const {
  return std::ranges::find(values_, value) != values_.end();
}

std::optional<std::size_t> cards::index_of(card value) const {
  auto it = std::ranges::find(values_, value);
  if (it == values_.end()) return std::nullopt;
  return static_cast<std::size_t>(std::distance(values_.begin(), it));
}

const card& cards::at(std::size_t index) const {
  return values_.at(index);
}

const std::vector<card>& cards::values() const {
  return values_;
}

void cards::append(card value) {
  values_.push_back(value);
}

void cards::append(cards values) {
  for (auto value : values.values_) {
    append(value);
  }
}

card cards::remove_at(std::size_t index) {
  if (index >= values_.size()) {
    throw std::out_of_range("card index out of range");
  }
  const auto value = values_[index];
  values_.erase(values_.begin() + static_cast<std::ptrdiff_t>(index));
  return value;
}

bool cards::remove(card value) {
  auto it = std::ranges::find(values_, value);
  if (it == values_.end()) return false;
  values_.erase(it);
  return true;
}

cards cards::deal(std::size_t count) {
  if (count > values_.size()) {
    throw std::runtime_error("deck exhausted while dealing cards");
  }
  std::vector<card> out;
  out.reserve(count);
  for (std::size_t i = 0; i < count; ++i) {
    out.push_back(values_.back());
    values_.pop_back();
  }
  return cards(out);
}

void cards::shuffle(std::mt19937& rng) {
  std::shuffle(values_.begin(), values_.end(), rng);
}

void cards::sort_by_string() {
  std::ranges::sort(values_, [](card lhs, card rhs) {
    return baloot::to_string(lhs) < baloot::to_string(rhs);
  });
}

std::string cards::to_string() const {
  std::ostringstream out;
  for (std::size_t i = 0; i < values_.size(); ++i) {
    if (i != 0) out << ' ';
    out << baloot::to_string(values_[i]);
  }
  return out.str();
}

cards make_deck_32() {
  std::vector<card> deck;
  deck.reserve(32);
  for (auto s : {suit::clubs, suit::diamonds, suit::hearts, suit::spades}) {
    for (auto r : {rank::seven, rank::eight, rank::nine, rank::ten, rank::jack,
                   rank::queen, rank::king, rank::ace}) {
      deck.push_back(card{s, r});
    }
  }
  return cards(deck);
}

cards parse_cards(std::string_view text) {
  std::istringstream input{std::string(text)};
  std::vector<card> values;
  std::string token;
  while (input >> token) {
    auto parsed = parse_card(token);
    if (!parsed) {
      throw std::invalid_argument("invalid card token: " + token);
    }
    values.push_back(*parsed);
  }
  return cards(values);
}

bool has_duplicates(std::span<const card> values) {
  for (std::size_t i = 0; i < values.size(); ++i) {
    for (std::size_t j = i + 1; j < values.size(); ++j) {
      if (values[i] == values[j]) return true;
    }
  }
  return false;
}

}  // namespace baloot
