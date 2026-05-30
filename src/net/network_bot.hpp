#pragma once

#include "core/bot.hpp"
#include "net/socket.hpp"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>

namespace baloot::net {

struct network_bot_options {
  int read_timeout_ms = 5000;
  std::size_t max_frame_bytes = 64 * 1024;
};

class network_bot : public bot_base {
 public:
  network_bot(int id, std::shared_ptr<tcp_connection> connection,
              std::string match_id, network_bot_options options = {});

  std::vector<action> read() override;
  void write(std::vector<action> actions) override;
  int id() override;

  void send_control(const control_message& message);
  [[nodiscard]] std::shared_ptr<tcp_connection> connection() const;

 private:
  int id_{};
  std::shared_ptr<tcp_connection> connection_;
  std::string match_id_;
  network_bot_options options_;
  std::uint64_t next_out_seq_{1};
  std::uint64_t expected_in_seq_{1};
};

}  // namespace baloot::net
