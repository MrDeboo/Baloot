#pragma once

#include "core/game_state.hpp"
#include "net/socket.hpp"

#include <cstdint>
#include <string>

namespace baloot {

struct reference_client_options {
  std::string host = "127.0.0.1";
  std::uint16_t port = 33999;
  std::string name = "baloot-bot";
  unsigned int seed = 0;
  int read_timeout_ms = 10000;
  std::size_t max_frame_bytes = 64 * 1024;
};

struct reference_client_result {
  int self_id{};
  int team_a_score{};
  int team_b_score{};
  team_id winner{team_id::a};
};

reference_client_result run_reference_client(reference_client_options options);

}  // namespace baloot
