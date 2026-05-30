#include "core/action.hpp"

#include <algorithm>
#include <cctype>
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

}  // namespace

bool action::valid() const {
  return actor_id >= 0;
}

const std::string& action::operator[](std::string_view key) const {
  auto it = data.find(std::string(key));
  if (it == data.end()) {
    throw std::out_of_range("missing action data key: " + std::string(key));
  }
  return it->second;
}

std::optional<std::string> action::maybe(std::string_view key) const {
  auto it = data.find(std::string(key));
  if (it == data.end()) return std::nullopt;
  return it->second;
}

std::string to_string(action_type value) {
  switch (value) {
    case action_type::new_sakkah:
      return "NEW_SAKKAH";
    case action_type::new_game:
      return "NEW_GAME";
    case action_type::deal_1:
      return "DEAL_1";
    case action_type::middle_card:
      return "MIDDLE_CARD";
    case action_type::buy_call:
      return "BUY_CALL";
    case action_type::deal_2:
      return "DEAL_2";
    case action_type::state_project:
      return "STATE_PROJECT";
    case action_type::show_project:
      return "SHOW_PROJECT";
    case action_type::play_card:
      return "PLAY_CARD";
    case action_type::ikkah:
      return "IKKAH";
    case action_type::baloot:
      return "BALOOT";
  }
  return "UNKNOWN";
}

std::optional<action_type> parse_action_type(std::string_view value) {
  const auto token = upper(value);
  if (token == "NEW_SAKKAH") return action_type::new_sakkah;
  if (token == "NEW_GAME") return action_type::new_game;
  if (token == "DEAL_1") return action_type::deal_1;
  if (token == "MIDDLE_CARD") return action_type::middle_card;
  if (token == "BUY_CALL") return action_type::buy_call;
  if (token == "DEAL_2") return action_type::deal_2;
  if (token == "STATE_PROJECT") return action_type::state_project;
  if (token == "SHOW_PROJECT") return action_type::show_project;
  if (token == "PLAY_CARD") return action_type::play_card;
  if (token == "IKKAH") return action_type::ikkah;
  if (token == "BALOOT") return action_type::baloot;
  return std::nullopt;
}

action make_action(int actor_id, action_type type,
                   std::map<std::string, std::string> data) {
  return action{actor_id, type, std::move(data)};
}

}  // namespace baloot
