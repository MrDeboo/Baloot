#pragma once

#include "core/cards.hpp"
#include "core/rules.hpp"

#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace baloot {

enum class project_kind {
  sira,
  fifty,
  hundred,
  four_hundred,
};

struct project {
  int owner_id{};
  project_kind kind{};
  cards project_cards;
  int score{};
  int comparison_value{};
  bool set_project{};
};

std::string to_string(project_kind kind);
std::optional<project_kind> parse_project_kind(std::string_view value);

project validate_project(int owner_id, const cards& hand, project_kind kind,
                         const cards& declared, game_mode mode);

std::vector<project> find_projects(int owner_id, const cards& hand,
                                   game_mode mode);

std::vector<project> winning_projects(const std::vector<project>& declared,
                                      const std::vector<int>& turn_order,
                                      auto team_of) {
  if (declared.empty()) return {};

  auto seat_index = [&](int player_id) {
    for (std::size_t i = 0; i < turn_order.size(); ++i) {
      if (turn_order[i] == player_id) return static_cast<int>(i);
    }
    return 999;
  };

  auto better = [&](const project& lhs, const project& rhs) {
    if (lhs.score != rhs.score) return lhs.score > rhs.score;
    if (lhs.set_project != rhs.set_project) return lhs.set_project;
    if (lhs.comparison_value != rhs.comparison_value) {
      return lhs.comparison_value > rhs.comparison_value;
    }
    return seat_index(lhs.owner_id) < seat_index(rhs.owner_id);
  };

  const project* best = &declared.front();
  for (const auto& item : declared) {
    if (better(item, *best)) best = &item;
  }

  const auto best_team = team_of(best->owner_id);
  std::vector<project> result;
  for (const auto& item : declared) {
    if (team_of(item.owner_id) == best_team) {
      result.push_back(item);
    }
  }
  return result;
}

}  // namespace baloot
