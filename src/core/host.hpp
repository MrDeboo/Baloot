#pragma once

#include "core/bot.hpp"
#include "core/game_state.hpp"
#include "core/scoring.hpp"

#include <functional>
#include <memory>
#include <random>
#include <string>
#include <unordered_map>

namespace baloot {

struct host_options {
  rules_config rules;
  unsigned int seed = 0xB41007;
  bool auto_gaid = true;
};

class host {
 public:
  host(std::vector<std::shared_ptr<bot_base>> players, host_options options = {});

  sakkah_result run_sakkah();

 private:
  std::vector<std::shared_ptr<bot_base>> players_;
  std::unordered_map<int, std::shared_ptr<bot_base>> by_id_;
  host_options options_;
  std::mt19937 rng_;
  std::array<int, 4> seats_{};
  std::unordered_map<int, team_id> fixed_teams_;
  std::vector<std::string> log_;

  [[nodiscard]] std::shared_ptr<bot_base> player(int id) const;
  [[nodiscard]] team_id team_of(int id) const;
  [[nodiscard]] int partner_of(int id) const;
  [[nodiscard]] std::string score_for(int receiver_id, int team_a, int team_b,
                                      bool our) const;

  void log(std::string message);
  void write_to(int id, std::vector<action> actions);
  void broadcast(std::vector<action> actions);
  void rotate_seats();

  game_result play_game(int game_number, int team_a_score, int team_b_score);
  std::optional<contract> run_bidding(const card& middle);
  void run_discussion(contract& contract_value);
  buy_call read_buy_call(int actor_id, int phase);
  action read_single_action(int actor_id, action_type expected);
};

}  // namespace baloot
