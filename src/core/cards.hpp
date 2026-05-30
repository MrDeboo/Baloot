#pragma once

#include "core/card.hpp"

#include <cstddef>
#include <optional>
#include <random>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace baloot {

class cards {
 public:
  cards() = default;
  explicit cards(std::vector<card> values);

  [[nodiscard]] std::size_t size() const;
  [[nodiscard]] bool empty() const;
  [[nodiscard]] bool contains(card value) const;
  [[nodiscard]] std::optional<std::size_t> index_of(card value) const;
  [[nodiscard]] const card& at(std::size_t index) const;
  [[nodiscard]] const std::vector<card>& values() const;

  void append(card value);
  void append(cards values);
  card remove_at(std::size_t index);
  bool remove(card value);
  cards deal(std::size_t count);
  void shuffle(std::mt19937& rng);
  void sort_by_string();

  [[nodiscard]] std::string to_string() const;

 private:
  std::vector<card> values_;
};

cards make_deck_32();
cards parse_cards(std::string_view text);
bool has_duplicates(std::span<const card> values);

}  // namespace baloot
