#include "bots/reference_client.hpp"
#include "core/rules.hpp"

#include <cstdint>
#include <iostream>
#include <string>

int main(int argc, char** argv) {
  baloot::reference_client_options options;

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--host" && i + 1 < argc) {
      options.host = argv[++i];
    } else if (arg == "--port" && i + 1 < argc) {
      options.port = static_cast<std::uint16_t>(std::stoi(argv[++i]));
    } else if (arg == "--name" && i + 1 < argc) {
      options.name = argv[++i];
    } else if (arg == "--seed" && i + 1 < argc) {
      options.seed = static_cast<unsigned int>(std::stoul(argv[++i]));
    }
  }

  try {
    auto result = baloot::run_reference_client(options);
    std::cout << "MATCH_END self=" << result.self_id
              << " A=" << result.team_a_score
              << " B=" << result.team_b_score
              << " winner=" << baloot::to_string(result.winner) << '\n';
  } catch (const std::exception& error) {
    std::cerr << "baloot-bot error: " << error.what() << '\n';
    return 1;
  }
}
