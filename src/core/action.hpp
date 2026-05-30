#pragma once

#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace baloot {

enum class action_type {
  new_sakkah,
  new_game,
  deal_1,
  middle_card,
  buy_call,
  deal_2,
  state_project,
  show_project,
  play_card,
  ikkah,
  baloot,
};

struct action {
  int actor_id{};
  action_type type{};
  std::map<std::string, std::string> data;

  [[nodiscard]] bool valid() const;
  [[nodiscard]] const std::string& operator[](std::string_view key) const;
  [[nodiscard]] std::optional<std::string> maybe(std::string_view key) const;
};

std::string to_string(action_type value);
std::optional<action_type> parse_action_type(std::string_view value);

action make_action(int actor_id, action_type type,
                   std::map<std::string, std::string> data = {});

}  // namespace baloot
