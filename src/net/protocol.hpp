#pragma once

#include "core/action.hpp"

#include <cstddef>
#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace baloot::net {

class protocol_error : public std::runtime_error {
 public:
  explicit protocol_error(const std::string& message) : std::runtime_error(message) {}
};

struct action_envelope {
  std::uint64_t seq{};
  std::string match_id;
  std::vector<action> actions;
};

struct control_message {
  std::string kind;
  std::map<std::string, std::string> fields;
  std::vector<std::map<std::string, std::string>> players;
};

std::string json_escape(std::string_view value);
std::string message_kind(std::string_view json);

std::string action_to_json(const action& value);
action action_from_json(std::string_view json);

std::string actions_to_json(const std::vector<action>& actions);
std::vector<action> actions_from_json(std::string_view json);

std::string envelope_to_json(const action_envelope& value);
action_envelope envelope_from_json(std::string_view json);

std::string control_to_json(const control_message& value);
control_message control_from_json(std::string_view json);

}  // namespace baloot::net
