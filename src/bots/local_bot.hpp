#pragma once

#include "core/bot.hpp"
#include "core/game_state.hpp"

#include <optional>
#include <random>
#include <unordered_map>

namespace baloot {

class local_bot : public bot_base {
 public:
  explicit local_bot(int id, unsigned int seed = 0);

  std::vector<action> read() override;
  void write(std::vector<action> actions) override;
  int id() override;

 private:
  int id_{};
  std::mt19937 rng_;
  cards hand_;
  std::optional<card> middle_;
  std::optional<contract> contract_;
  std::array<int, 4> seats_{};
  bool teams_set_{};
  std::unordered_map<int, team_id> teams_;
  std::vector<trick_play> current_trick_;
  bool projects_declared_{};
  bool bought_this_game_{};
  bool in_play_{};

  [[nodiscard]] team_id team_of(int id) const;
  [[nodiscard]] bool should_buy() const;
  [[nodiscard]] std::vector<action> play_actions();
};

}  // namespace baloot
