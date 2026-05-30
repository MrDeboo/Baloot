#pragma once

#include "core/host.hpp"
#include "net/network_bot.hpp"
#include "net/socket.hpp"

#include <cstdint>
#include <atomic>
#include <future>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace baloot::net {

struct server_options {
  std::uint16_t port = 0;
  host_options game;
  network_bot_options bot;
  int accept_timeout_ms = 1000;
  std::size_t max_concurrent_matches = 4;
  std::string log_level = "info";
};

struct server_result {
  sakkah_result match;
  std::vector<std::string> client_names;
};

class single_match_server {
 public:
  explicit single_match_server(server_options options = {});

  [[nodiscard]] std::uint16_t port() const;
  server_result run_once();

 private:
  server_options options_;
  tcp_listener listener_;
  std::string match_id_ = "m-000001";
};

class lobby_server {
 public:
  explicit lobby_server(server_options options = {});

  [[nodiscard]] std::uint16_t port() const;
  std::vector<server_result> run_matches(std::size_t match_count);
  std::vector<server_result> run_until_stopped(const std::atomic_bool& stop_requested);

 private:
  struct lobby_client {
    std::shared_ptr<tcp_connection> connection;
    std::string name;
    int connection_id{};
  };

  server_options options_;
  tcp_listener listener_;

  std::optional<lobby_client> try_accept_client(int connection_id,
                                                bool allow_accept_timeout);
  server_result run_match(std::vector<lobby_client> clients, std::size_t match_number);
};

}  // namespace baloot::net
