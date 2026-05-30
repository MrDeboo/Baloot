#include "net/protocol.hpp"

#include <cctype>
#include <cstdlib>
#include <iomanip>
#include <limits>
#include <map>
#include <optional>
#include <sstream>
#include <variant>

namespace baloot::net {
namespace {

struct json_value {
  using array = std::vector<json_value>;
  using object = std::map<std::string, json_value>;

  std::variant<std::nullptr_t, bool, double, std::string, array, object> value;
};

class json_parser {
 public:
  explicit json_parser(std::string_view text) : text_(text) {}

  json_value parse() {
    auto value = parse_value();
    skip_ws();
    if (pos_ != text_.size()) {
      throw protocol_error("unexpected trailing JSON input");
    }
    return value;
  }

 private:
  std::string_view text_;
  std::size_t pos_{};

  [[nodiscard]] bool eof() const { return pos_ >= text_.size(); }

  [[nodiscard]] char peek() const {
    if (eof()) throw protocol_error("unexpected end of JSON input");
    return text_[pos_];
  }

  char get() {
    const auto ch = peek();
    ++pos_;
    return ch;
  }

  void skip_ws() {
    while (!eof() && std::isspace(static_cast<unsigned char>(text_[pos_]))) {
      ++pos_;
    }
  }

  bool consume(std::string_view token) {
    if (text_.substr(pos_, token.size()) == token) {
      pos_ += token.size();
      return true;
    }
    return false;
  }

  json_value parse_value() {
    skip_ws();
    const auto ch = peek();
    if (ch == '"') return json_value{parse_string()};
    if (ch == '{') return json_value{parse_object()};
    if (ch == '[') return json_value{parse_array()};
    if (ch == 't') {
      if (!consume("true")) throw protocol_error("invalid JSON true literal");
      return json_value{true};
    }
    if (ch == 'f') {
      if (!consume("false")) throw protocol_error("invalid JSON false literal");
      return json_value{false};
    }
    if (ch == 'n') {
      if (!consume("null")) throw protocol_error("invalid JSON null literal");
      return json_value{nullptr};
    }
    if (ch == '-' || std::isdigit(static_cast<unsigned char>(ch))) {
      return json_value{parse_number()};
    }
    throw protocol_error("invalid JSON value");
  }

  std::string parse_string() {
    if (get() != '"') throw protocol_error("expected JSON string");
    std::string out;
    while (true) {
      if (eof()) throw protocol_error("unterminated JSON string");
      const auto ch = get();
      if (ch == '"') return out;
      if (ch != '\\') {
        if (static_cast<unsigned char>(ch) < 0x20) {
          throw protocol_error("control character in JSON string");
        }
        out.push_back(ch);
        continue;
      }

      if (eof()) throw protocol_error("unterminated JSON escape");
      const auto esc = get();
      switch (esc) {
        case '"':
        case '\\':
        case '/':
          out.push_back(esc);
          break;
        case 'b':
          out.push_back('\b');
          break;
        case 'f':
          out.push_back('\f');
          break;
        case 'n':
          out.push_back('\n');
          break;
        case 'r':
          out.push_back('\r');
          break;
        case 't':
          out.push_back('\t');
          break;
        case 'u':
          out += parse_unicode_escape();
          break;
        default:
          throw protocol_error("invalid JSON escape");
      }
    }
  }

  std::string parse_unicode_escape() {
    int code = 0;
    for (int i = 0; i < 4; ++i) {
      if (eof()) throw protocol_error("short unicode escape");
      const auto ch = get();
      code <<= 4;
      if (ch >= '0' && ch <= '9') code += ch - '0';
      else if (ch >= 'a' && ch <= 'f') code += 10 + ch - 'a';
      else if (ch >= 'A' && ch <= 'F') code += 10 + ch - 'A';
      else throw protocol_error("invalid unicode escape");
    }

    std::string out;
    if (code <= 0x7F) {
      out.push_back(static_cast<char>(code));
    } else if (code <= 0x7FF) {
      out.push_back(static_cast<char>(0xC0 | ((code >> 6) & 0x1F)));
      out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    } else {
      out.push_back(static_cast<char>(0xE0 | ((code >> 12) & 0x0F)));
      out.push_back(static_cast<char>(0x80 | ((code >> 6) & 0x3F)));
      out.push_back(static_cast<char>(0x80 | (code & 0x3F)));
    }
    return out;
  }

  double parse_number() {
    const auto start = pos_;
    if (peek() == '-') ++pos_;
    if (eof()) throw protocol_error("invalid JSON number");
    if (peek() == '0') {
      ++pos_;
    } else if (std::isdigit(static_cast<unsigned char>(peek()))) {
      while (!eof() && std::isdigit(static_cast<unsigned char>(peek()))) ++pos_;
    } else {
      throw protocol_error("invalid JSON number");
    }

    if (!eof() && peek() == '.') {
      ++pos_;
      if (eof() || !std::isdigit(static_cast<unsigned char>(peek()))) {
        throw protocol_error("invalid JSON number fraction");
      }
      while (!eof() && std::isdigit(static_cast<unsigned char>(peek()))) ++pos_;
    }

    if (!eof() && (peek() == 'e' || peek() == 'E')) {
      ++pos_;
      if (!eof() && (peek() == '+' || peek() == '-')) ++pos_;
      if (eof() || !std::isdigit(static_cast<unsigned char>(peek()))) {
        throw protocol_error("invalid JSON number exponent");
      }
      while (!eof() && std::isdigit(static_cast<unsigned char>(peek()))) ++pos_;
    }

    const auto token = text_.substr(start, pos_ - start);
    const auto token_text = std::string(token);
    char* end = nullptr;
    const double out = std::strtod(token_text.c_str(), &end);
    if (end != token_text.c_str() + token_text.size()) {
      throw protocol_error("invalid JSON number conversion");
    }
    return out;
  }

  json_value::array parse_array() {
    if (get() != '[') throw protocol_error("expected JSON array");
    json_value::array out;
    skip_ws();
    if (!eof() && peek() == ']') {
      ++pos_;
      return out;
    }
    while (true) {
      out.push_back(parse_value());
      skip_ws();
      const auto ch = get();
      if (ch == ']') return out;
      if (ch != ',') throw protocol_error("expected JSON array separator");
    }
  }

  json_value::object parse_object() {
    if (get() != '{') throw protocol_error("expected JSON object");
    json_value::object out;
    skip_ws();
    if (!eof() && peek() == '}') {
      ++pos_;
      return out;
    }
    while (true) {
      skip_ws();
      if (peek() != '"') throw protocol_error("expected JSON object key");
      auto key = parse_string();
      skip_ws();
      if (get() != ':') throw protocol_error("expected JSON key separator");
      out.emplace(std::move(key), parse_value());
      skip_ws();
      const auto ch = get();
      if (ch == '}') return out;
      if (ch != ',') throw protocol_error("expected JSON object separator");
    }
  }
};

const json_value::object& as_object(const json_value& value) {
  auto object = std::get_if<json_value::object>(&value.value);
  if (!object) throw protocol_error("expected JSON object");
  return *object;
}

const json_value::array& as_array(const json_value& value) {
  auto array = std::get_if<json_value::array>(&value.value);
  if (!array) throw protocol_error("expected JSON array");
  return *array;
}

const std::string& as_string(const json_value& value) {
  auto str = std::get_if<std::string>(&value.value);
  if (!str) throw protocol_error("expected JSON string");
  return *str;
}

double as_number(const json_value& value) {
  auto number = std::get_if<double>(&value.value);
  if (!number) throw protocol_error("expected JSON number");
  return *number;
}

const json_value& at(const json_value::object& object, std::string_view key) {
  auto it = object.find(std::string(key));
  if (it == object.end()) throw protocol_error("missing JSON key: " + std::string(key));
  return it->second;
}

std::string string_at(const json_value::object& object, std::string_view key) {
  return as_string(at(object, key));
}

std::uint64_t uint_at(const json_value::object& object, std::string_view key) {
  const auto value = as_number(at(object, key));
  if (value < 0 || value > static_cast<double>(std::numeric_limits<std::uint64_t>::max())) {
    throw protocol_error("JSON number out of unsigned range");
  }
  return static_cast<std::uint64_t>(value);
}

std::map<std::string, std::string> string_map_from_json(const json_value& value) {
  std::map<std::string, std::string> out;
  for (const auto& [key, item] : as_object(value)) {
    out.emplace(key, as_string(item));
  }
  return out;
}

std::string json_string(std::string_view value) {
  return "\"" + json_escape(value) + "\"";
}

std::string string_map_to_json(const std::map<std::string, std::string>& values) {
  std::ostringstream out;
  out << '{';
  bool first = true;
  for (const auto& [key, value] : values) {
    if (!first) out << ',';
    first = false;
    out << json_string(key) << ':' << json_string(value);
  }
  out << '}';
  return out.str();
}

}  // namespace

std::string json_escape(std::string_view value) {
  std::ostringstream out;
  for (unsigned char ch : value) {
    switch (ch) {
      case '"':
        out << "\\\"";
        break;
      case '\\':
        out << "\\\\";
        break;
      case '\b':
        out << "\\b";
        break;
      case '\f':
        out << "\\f";
        break;
      case '\n':
        out << "\\n";
        break;
      case '\r':
        out << "\\r";
        break;
      case '\t':
        out << "\\t";
        break;
      default:
        if (ch < 0x20) {
          out << "\\u" << std::hex << std::setw(4) << std::setfill('0')
              << static_cast<int>(ch) << std::dec << std::setfill(' ');
        } else {
          out << static_cast<char>(ch);
        }
        break;
    }
  }
  return out.str();
}

std::string message_kind(std::string_view json) {
  auto root = json_parser(json).parse();
  return string_at(as_object(root), "kind");
}

std::string action_to_json(const action& value) {
  std::ostringstream out;
  out << '{'
      << "\"actor_id\":" << value.actor_id << ','
      << "\"type\":" << json_string(to_string(value.type)) << ','
      << "\"data\":" << string_map_to_json(value.data)
      << '}';
  return out.str();
}

action action_from_json(std::string_view json) {
  auto root = json_parser(json).parse();
  const auto& object = as_object(root);
  const auto actor = static_cast<int>(uint_at(object, "actor_id"));
  auto type = parse_action_type(string_at(object, "type"));
  if (!type) throw protocol_error("unknown action type");
  return action{actor, *type, string_map_from_json(at(object, "data"))};
}

std::string actions_to_json(const std::vector<action>& actions) {
  std::ostringstream out;
  out << '[';
  for (std::size_t i = 0; i < actions.size(); ++i) {
    if (i != 0) out << ',';
    out << action_to_json(actions[i]);
  }
  out << ']';
  return out.str();
}

std::vector<action> actions_from_json(std::string_view json) {
  auto root = json_parser(json).parse();
  std::vector<action> out;
  for (const auto& item : as_array(root)) {
    const auto& object = as_object(item);
    const auto actor = static_cast<int>(uint_at(object, "actor_id"));
    auto type = parse_action_type(string_at(object, "type"));
    if (!type) throw protocol_error("unknown action type");
    out.push_back(action{actor, *type, string_map_from_json(at(object, "data"))});
  }
  return out;
}

std::string envelope_to_json(const action_envelope& value) {
  std::ostringstream out;
  out << '{'
      << "\"kind\":\"ACTIONS\","
      << "\"seq\":" << value.seq << ','
      << "\"match_id\":" << json_string(value.match_id) << ','
      << "\"actions\":" << actions_to_json(value.actions)
      << '}';
  return out.str();
}

action_envelope envelope_from_json(std::string_view json) {
  auto root = json_parser(json).parse();
  const auto& object = as_object(root);
  const auto kind = string_at(object, "kind");
  if (kind != "ACTIONS") throw protocol_error("expected ACTIONS envelope");
  action_envelope out;
  out.seq = uint_at(object, "seq");
  out.match_id = string_at(object, "match_id");

  for (const auto& item : as_array(at(object, "actions"))) {
    const auto& action_object = as_object(item);
    const auto actor = static_cast<int>(uint_at(action_object, "actor_id"));
    auto type = parse_action_type(string_at(action_object, "type"));
    if (!type) throw protocol_error("unknown action type");
    out.actions.push_back(
        action{actor, *type, string_map_from_json(at(action_object, "data"))});
  }
  return out;
}

std::string control_to_json(const control_message& value) {
  std::ostringstream out;
  out << '{' << "\"kind\":" << json_string(value.kind);
  for (const auto& [key, field] : value.fields) {
    out << ',' << json_string(key) << ':' << json_string(field);
  }
  if (!value.players.empty()) {
    out << ",\"players\":[";
    for (std::size_t i = 0; i < value.players.size(); ++i) {
      if (i != 0) out << ',';
      out << string_map_to_json(value.players[i]);
    }
    out << ']';
  }
  out << '}';
  return out.str();
}

control_message control_from_json(std::string_view json) {
  auto root = json_parser(json).parse();
  const auto& object = as_object(root);
  control_message out;
  out.kind = string_at(object, "kind");
  for (const auto& [key, value] : object) {
    if (key == "kind") continue;
    if (key == "players") {
      for (const auto& item : as_array(value)) {
        out.players.push_back(string_map_from_json(item));
      }
      continue;
    }
    out.fields.emplace(key, as_string(value));
  }
  return out;
}

}  // namespace baloot::net
