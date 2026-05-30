#pragma once

#include "core/cards.hpp"

#include <optional>
#include <stdexcept>
#include <string>

namespace baloot {

class gaid : public std::runtime_error {
 public:
  gaid(std::string type, int source_id, std::optional<int> target_id,
       std::optional<card> offending, cards expected, std::string message)
      : std::runtime_error(message),
        type_(std::move(type)),
        source_id_(source_id),
        target_id_(target_id),
        offending_(offending),
        expected_(std::move(expected)) {}

  [[nodiscard]] const std::string& type() const { return type_; }
  [[nodiscard]] int source_id() const { return source_id_; }
  [[nodiscard]] std::optional<int> target_id() const { return target_id_; }
  [[nodiscard]] std::optional<card> offending_card() const { return offending_; }
  [[nodiscard]] const cards& expected_cards() const { return expected_; }

 private:
  std::string type_;
  int source_id_{};
  std::optional<int> target_id_;
  std::optional<card> offending_;
  cards expected_;
};

class invalid_action : public gaid {
 public:
  invalid_action(int source_id, std::string message)
      : gaid("INVALID_ACTION", source_id, std::nullopt, std::nullopt, cards{},
             std::move(message)) {}
};

class invalid_cut : public gaid {
 public:
  invalid_cut(int source_id, card offending, cards expected, std::string message)
      : gaid("INVALID_CUT", source_id, std::nullopt, offending,
             std::move(expected), std::move(message)) {}
};

class didnt_knock : public gaid {
 public:
  didnt_knock(int source_id, card offending, cards expected, std::string message)
      : gaid("DIDNT_KNOCK", source_id, std::nullopt, offending,
             std::move(expected), std::move(message)) {}
};

class trump_initiation : public gaid {
 public:
  trump_initiation(int source_id, card offending, cards expected,
                   std::string message)
      : gaid("TRUMP_INITIATION", source_id, std::nullopt, offending,
             std::move(expected), std::move(message)) {}
};

class didnt_go_higher : public gaid {
 public:
  didnt_go_higher(int source_id, card offending, cards expected,
                  std::string message)
      : gaid("DIDNT_GO_HIGHER", source_id, std::nullopt, offending,
             std::move(expected), std::move(message)) {}
};

}  // namespace baloot
