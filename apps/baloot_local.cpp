#include "bots/local_bot.hpp"
#include "core/host.hpp"

#include <iostream>
#include <memory>
#include <vector>

int main(int argc, char** argv) {
  int target = 152;
  if (argc > 1) {
    target = std::stoi(argv[1]);
  }

  std::vector<std::shared_ptr<baloot::bot_base>> bots;
  bots.push_back(std::make_shared<baloot::local_bot>(1, 101));
  bots.push_back(std::make_shared<baloot::local_bot>(2, 202));
  bots.push_back(std::make_shared<baloot::local_bot>(3, 303));
  bots.push_back(std::make_shared<baloot::local_bot>(4, 404));

  baloot::host_options options;
  options.rules.target_score = target;
  options.seed = 123456;

  baloot::host game(std::move(bots), options);
  auto result = game.run_sakkah();

  for (const auto& line : result.log) {
    std::cout << line << '\n';
  }
  std::cout << "final A=" << result.team_a_score << " B=" << result.team_b_score
            << " winner=" << baloot::to_string(result.winner)
            << " games=" << result.games_played << '\n';
}
