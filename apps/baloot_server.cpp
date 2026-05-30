#include "net/server.hpp"

#include <atomic>
#include <cstdint>
#include <csignal>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <string>

namespace {

std::atomic_bool stop_requested = false;

void handle_signal(int) {
  stop_requested.store(true);
}

std::string trim(std::string value) {
  const auto first = value.find_first_not_of(" \t\r\n");
  if (first == std::string::npos) return "";
  const auto last = value.find_last_not_of(" \t\r\n");
  return value.substr(first, last - first + 1);
}

std::map<std::string, std::string> read_config_file(const std::string& path) {
  std::ifstream input(path);
  if (!input) {
    throw std::runtime_error("could not open config file: " + path);
  }
  std::map<std::string, std::string> values;
  std::string line;
  while (std::getline(input, line)) {
    const auto comment = line.find('#');
    if (comment != std::string::npos) line.erase(comment);
    line = trim(line);
    if (line.empty()) continue;
    const auto equals = line.find('=');
    if (equals == std::string::npos) {
      throw std::runtime_error("invalid config line, expected key=value: " + line);
    }
    values.emplace(trim(line.substr(0, equals)), trim(line.substr(equals + 1)));
  }
  return values;
}

void apply_config(baloot::net::server_options& options, std::size_t& matches,
                  const std::map<std::string, std::string>& config) {
  for (const auto& [key, value] : config) {
    if (key == "port") {
      options.port = static_cast<std::uint16_t>(std::stoi(value));
    } else if (key == "target_score") {
      options.game.rules.target_score = std::stoi(value);
    } else if (key == "matches") {
      matches = static_cast<std::size_t>(std::stoul(value));
    } else if (key == "max_concurrent_matches") {
      options.max_concurrent_matches = static_cast<std::size_t>(std::stoul(value));
    } else if (key == "read_timeout_ms") {
      options.bot.read_timeout_ms = std::stoi(value);
    } else if (key == "accept_timeout_ms") {
      options.accept_timeout_ms = std::stoi(value);
    } else if (key == "max_frame_bytes") {
      options.bot.max_frame_bytes = static_cast<std::size_t>(std::stoul(value));
    } else if (key == "seed") {
      options.game.seed = static_cast<unsigned int>(std::stoul(value));
    } else if (key == "log_level") {
      options.log_level = value;
    }
  }
}

}  // namespace

int main(int argc, char** argv) {
  baloot::net::server_options options;
  options.port = 33999;
  options.game.rules.target_score = 152;
  std::size_t matches = 1;

  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--config" && i + 1 < argc) {
      apply_config(options, matches, read_config_file(argv[++i]));
    } else if (arg == "--port" && i + 1 < argc) {
      options.port = static_cast<std::uint16_t>(std::stoi(argv[++i]));
    } else if (arg == "--target-score" && i + 1 < argc) {
      options.game.rules.target_score = std::stoi(argv[++i]);
    } else if (arg == "--matches" && i + 1 < argc) {
      matches = static_cast<std::size_t>(std::stoul(argv[++i]));
    } else if (arg == "--max-concurrent-matches" && i + 1 < argc) {
      options.max_concurrent_matches = static_cast<std::size_t>(std::stoul(argv[++i]));
    } else if (arg == "--read-timeout-ms" && i + 1 < argc) {
      options.bot.read_timeout_ms = std::stoi(argv[++i]);
    } else if (arg == "--accept-timeout-ms" && i + 1 < argc) {
      options.accept_timeout_ms = std::stoi(argv[++i]);
    } else if (arg == "--max-frame-bytes" && i + 1 < argc) {
      options.bot.max_frame_bytes = static_cast<std::size_t>(std::stoul(argv[++i]));
    } else if (arg == "--seed" && i + 1 < argc) {
      options.game.seed = static_cast<unsigned int>(std::stoul(argv[++i]));
    } else if (arg == "--log-level" && i + 1 < argc) {
      options.log_level = argv[++i];
    }
  }

  std::signal(SIGINT, handle_signal);
  std::signal(SIGTERM, handle_signal);

  try {
    baloot::net::lobby_server server(options);
    std::cout << "baloot-server listening on 127.0.0.1:" << server.port() << '\n';
    auto results = matches == 0 ? server.run_until_stopped(stop_requested)
                                : server.run_matches(matches);
    for (std::size_t i = 0; i < results.size(); ++i) {
      std::cout << "match " << (i + 1) << '\n';
      for (const auto& line : results[i].match.log) {
        std::cout << line << '\n';
      }
      std::cout << "MATCH_END A=" << results[i].match.team_a_score
                << " B=" << results[i].match.team_b_score
                << " winner=" << baloot::to_string(results[i].match.winner) << '\n';
    }
  } catch (const std::exception& error) {
    std::cerr << "baloot-server error: " << error.what() << '\n';
    return 1;
  }
}
