#pragma once

#include "net/frame.hpp"
#include "net/protocol.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace baloot::net {

class tcp_connection {
 public:
  tcp_connection() = default;
  explicit tcp_connection(int fd);
  tcp_connection(const tcp_connection&) = delete;
  tcp_connection& operator=(const tcp_connection&) = delete;
  tcp_connection(tcp_connection&& other) noexcept;
  tcp_connection& operator=(tcp_connection&& other) noexcept;
  ~tcp_connection();

  [[nodiscard]] bool valid() const;
  [[nodiscard]] int fd() const;

  void close();
  std::string read_frame(int timeout_ms, std::size_t max_frame_bytes);
  void write_frame(std::string_view payload);

 private:
  int fd_ = -1;
  std::string read_buffer_;
};

class tcp_listener {
 public:
  explicit tcp_listener(std::uint16_t port);
  tcp_listener(const tcp_listener&) = delete;
  tcp_listener& operator=(const tcp_listener&) = delete;
  tcp_listener(tcp_listener&& other) noexcept;
  tcp_listener& operator=(tcp_listener&& other) noexcept;
  ~tcp_listener();

  [[nodiscard]] bool valid() const;
  [[nodiscard]] int fd() const;
  [[nodiscard]] std::uint16_t port() const;

  tcp_connection accept_one(int timeout_ms = -1);
  void close();

 private:
  int fd_ = -1;
  std::uint16_t port_{};
};

tcp_connection connect_tcp(std::string_view host, std::uint16_t port,
                           int timeout_ms = 5000);

}  // namespace baloot::net
