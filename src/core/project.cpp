#include "core/project.hpp"

#include "core/gaid.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <map>
#include <set>
#include <stdexcept>

namespace baloot {
namespace {

std::string upper(std::string_view value) {
  std::string out(value);
  std::ranges::transform(out, out.begin(), [](unsigned char ch) {
    return static_cast<char>(std::toupper(ch));
  });
  return out;
}

bool same_suit(const std::vector<card>& values) {
  return std::ranges::all_of(values, [&](card value) { return value.s == values[0].s; });
}

bool consecutive_sequence(std::vector<card> values) {
  std::ranges::sort(values, {}, &card::r);
  for (std::size_t i = 1; i < values.size(); ++i) {
    if (!ranks_consecutive(values[i - 1].r, values[i].r)) return false;
  }
  return true;
}

int top_sequence_value(std::vector<card> values) {
  auto best = std::ranges::max(values, {}, [](card value) {
    return rank_sequence_index(value.r);
  });
  return rank_sequence_index(best.r);
}

bool project_cards_in_hand(const cards& hand, const cards& declared) {
  for (const auto value : declared.values()) {
    if (!hand.contains(value)) return false;
  }
  return !has_duplicates(declared.values());
}

bool rank_allowed_for_four_kind(rank value) {
  return value == rank::ten || value == rank::jack || value == rank::queen ||
         value == rank::king || value == rank::ace;
}

int sequence_score(project_kind kind, game_mode mode) {
  switch (kind) {
    case project_kind::sira:
      return mode == game_mode::hukum ? 2 : 4;
    case project_kind::fifty:
      return mode == game_mode::hukum ? 5 : 10;
    case project_kind::hundred:
      return mode == game_mode::hukum ? 10 : 20;
    case project_kind::four_hundred:
      return mode == game_mode::hukum ? 0 : 40;
  }
  return 0;
}

}  // namespace

std::string to_string(project_kind kind) {
  switch (kind) {
    case project_kind::sira:
      return "SIRA";
    case project_kind::fifty:
      return "FIFTY";
    case project_kind::hundred:
      return "HUNDRED";
    case project_kind::four_hundred:
      return "FOUR_HUNDRED";
  }
  return "UNKNOWN";
}

std::optional<project_kind> parse_project_kind(std::string_view value) {
  const auto token = upper(value);
  if (token == "SIRA") return project_kind::sira;
  if (token == "FIFTY") return project_kind::fifty;
  if (token == "HUNDRED") return project_kind::hundred;
  if (token == "FOUR_HUNDRED") return project_kind::four_hundred;
  return std::nullopt;
}

project validate_project(int owner_id, const cards& hand, project_kind kind,
                         const cards& declared, game_mode mode) {
  if (!project_cards_in_hand(hand, declared)) {
    throw invalid_action(owner_id, "declared project uses cards not in hand or duplicates");
  }
  const auto values = declared.values();
  if (values.empty()) {
    throw invalid_action(owner_id, "declared project has no cards");
  }

  bool valid = false;
  bool set_project = false;
  int comparison = 0;

  if (kind == project_kind::sira || kind == project_kind::fifty ||
      kind == project_kind::hundred) {
    const auto expected_size = kind == project_kind::sira
                                   ? 3U
                                   : kind == project_kind::fifty ? 4U : 5U;
    if (values.size() == expected_size && same_suit(values) &&
        consecutive_sequence(values)) {
      valid = true;
      comparison = top_sequence_value(values);
    }
  }

  if (kind == project_kind::hundred && values.size() == 4) {
    const auto same_rank = std::ranges::all_of(values, [&](card value) {
      return value.r == values.front().r;
    });
    if (same_rank && rank_allowed_for_four_kind(values.front().r)) {
      valid = true;
      set_project = true;
      comparison = rank_sequence_index(values.front().r);
    }
  }

  if (kind == project_kind::four_hundred) {
    const auto all_aces = values.size() == 4 && std::ranges::all_of(values, [](card value) {
                            return value.r == rank::ace;
                          });
    valid = all_aces && mode == game_mode::sun;
    set_project = true;
    comparison = rank_sequence_index(rank::ace);
  }

  if (!valid) {
    throw invalid_action(owner_id, "invalid project declaration");
  }

  return project{owner_id, kind, declared, sequence_score(kind, mode), comparison,
                 set_project};
}

std::vector<project> find_projects(int owner_id, const cards& hand, game_mode mode) {
  std::vector<project> found;

  std::map<rank, std::vector<card>> by_rank;
  std::map<suit, std::vector<card>> by_suit;
  for (auto value : hand.values()) {
    by_rank[value.r].push_back(value);
    by_suit[value.s].push_back(value);
  }

  for (const auto& [r, values] : by_rank) {
    if (values.size() == 4 && r == rank::ace && mode == game_mode::sun) {
      found.push_back(validate_project(owner_id, hand, project_kind::four_hundred,
                                       cards(values), mode));
    } else if (values.size() == 4 && rank_allowed_for_four_kind(r)) {
      found.push_back(validate_project(owner_id, hand, project_kind::hundred,
                                       cards(values), mode));
    }
  }

  for (const auto& [s, values] : by_suit) {
    auto sorted = values;
    std::ranges::sort(sorted, [](card lhs, card rhs) {
      return rank_sequence_index(lhs.r) < rank_sequence_index(rhs.r);
    });
    for (std::size_t len : {5U, 4U, 3U}) {
      if (sorted.size() < len) continue;
      for (std::size_t start = 0; start + len <= sorted.size(); ++start) {
        std::vector<card> slice(sorted.begin() + static_cast<std::ptrdiff_t>(start),
                                sorted.begin() + static_cast<std::ptrdiff_t>(start + len));
        if (!consecutive_sequence(slice)) continue;
        const auto kind = len == 5 ? project_kind::hundred
                          : len == 4 ? project_kind::fifty
                                     : project_kind::sira;
        found.push_back(validate_project(owner_id, hand, kind, cards(slice), mode));
      }
    }
  }

  std::ranges::sort(found, [](const project& lhs, const project& rhs) {
    if (lhs.score != rhs.score) return lhs.score > rhs.score;
    if (lhs.comparison_value != rhs.comparison_value) {
      return lhs.comparison_value > rhs.comparison_value;
    }
    return lhs.project_cards.to_string() < rhs.project_cards.to_string();
  });

  std::vector<project> non_overlapping;
  std::set<card> used;
  for (const auto& item : found) {
    bool overlaps = false;
    for (auto value : item.project_cards.values()) {
      if (used.contains(value)) overlaps = true;
    }
    if (overlaps) continue;
    for (auto value : item.project_cards.values()) {
      used.insert(value);
    }
    non_overlapping.push_back(item);
  }
  return non_overlapping;
}

}  // namespace baloot
