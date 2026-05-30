#include "net/socket.hpp"

#include <arpa/inet.h>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdexcept>
#include <sys/socket.h>
#include <unistd.h>

namespace baloot::net {
namespace {

std::string errno_message(std::string_view prefix) {
  return std::string(prefix) + ": " + std::strerror(errno);
}

void close_fd(int& fd) {
  if (fd >= 0) {
    ::close(fd);
    fd = -1;
  }
}

void wait_fd(int fd, short events, int timeout_ms, std::string_view action) {
  pollfd pfd{};
  pfd.fd = fd;
  pfd.events = events;
  while (true) {
    const int rc = ::poll(&pfd, 1, timeout_ms);
    if (rc > 0) {
      if (pfd.revents & (POLLERR | POLLHUP | POLLNVAL)) {
        throw protocol_error(std::string(action) + " failed: socket closed");
      }
      return;
    }
    if (rc == 0) throw protocol_error(std::string(action) + " timed out");
    if (errno == EINTR) continue;
    throw protocol_error(errno_message(action));
  }
}

void set_reuseaddr(int fd) {
  int yes = 1;
  if (::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes)) != 0) {
    throw protocol_error(errno_message("setsockopt SO_REUSEADDR"));
  }
}

}  // namespace

tcp_connection::tcp_connection(int fd) : fd_(fd) {}

tcp_connection::tcp_connection(tcp_connection&& other) noexcept
    : fd_(other.fd_), read_buffer_(std::move(other.read_buffer_)) {
  other.fd_ = -1;
}

tcp_connection& tcp_connection::operator=(tcp_connection&& other) noexcept {
  if (this != &other) {
    close();
    fd_ = other.fd_;
    read_buffer_ = std::move(other.read_buffer_);
    other.fd_ = -1;
  }
  return *this;
}

tcp_connection::~tcp_connection() {
  close();
}

bool tcp_connection::valid() const {
  return fd_ >= 0;
}

int tcp_connection::fd() const {
  return fd_;
}

void tcp_connection::close() {
  close_fd(fd_);
}

std::string tcp_connection::read_frame(int timeout_ms, std::size_t max_frame_bytes) {
  if (!valid()) throw protocol_error("read on closed socket");

  while (true) {
    if (auto decoded = try_decode_frame(read_buffer_, max_frame_bytes)) {
      read_buffer_.erase(0, decoded->bytes_consumed);
      return decoded->payload;
    }

    wait_fd(fd_, POLLIN, timeout_ms, "socket read");
    char buffer[4096];
    const ssize_t n = ::recv(fd_, buffer, sizeof(buffer), 0);
    if (n > 0) {
      read_buffer_.append(buffer, static_cast<std::size_t>(n));
      continue;
    }
    if (n == 0) throw protocol_error("socket read failed: peer disconnected");
    if (errno == EINTR) continue;
    throw protocol_error(errno_message("socket read"));
  }
}

void tcp_connection::write_frame(std::string_view payload) {
  if (!valid()) throw protocol_error("write on closed socket");
  const auto frame = encode_frame(payload);
  std::size_t written = 0;
  while (written < frame.size()) {
    const ssize_t n =
        ::send(fd_, frame.data() + written, frame.size() - written, MSG_NOSIGNAL);
    if (n > 0) {
      written += static_cast<std::size_t>(n);
      continue;
    }
    if (n < 0 && errno == EINTR) continue;
    throw protocol_error(errno_message("socket write"));
  }
}

tcp_listener::tcp_listener(std::uint16_t port) {
  fd_ = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd_ < 0) throw protocol_error(errno_message("socket"));
  try {
    set_reuseaddr(fd_);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(port);
    if (::bind(fd_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
      throw protocol_error(errno_message("bind"));
    }
    if (::listen(fd_, 16) != 0) {
      throw protocol_error(errno_message("listen"));
    }

    sockaddr_in actual{};
    socklen_t len = sizeof(actual);
    if (::getsockname(fd_, reinterpret_cast<sockaddr*>(&actual), &len) != 0) {
      throw protocol_error(errno_message("getsockname"));
    }
    port_ = ntohs(actual.sin_port);
  } catch (...) {
    close();
    throw;
  }
}

tcp_listener::tcp_listener(tcp_listener&& other) noexcept
    : fd_(other.fd_), port_(other.port_) {
  other.fd_ = -1;
  other.port_ = 0;
}

tcp_listener& tcp_listener::operator=(tcp_listener&& other) noexcept {
  if (this != &other) {
    close();
    fd_ = other.fd_;
    port_ = other.port_;
    other.fd_ = -1;
    other.port_ = 0;
  }
  return *this;
}

tcp_listener::~tcp_listener() {
  close();
}

bool tcp_listener::valid() const {
  return fd_ >= 0;
}

int tcp_listener::fd() const {
  return fd_;
}

std::uint16_t tcp_listener::port() const {
  return port_;
}

tcp_connection tcp_listener::accept_one(int timeout_ms) {
  if (!valid()) throw protocol_error("accept on closed listener");
  if (timeout_ms >= 0) wait_fd(fd_, POLLIN, timeout_ms, "socket accept");
  while (true) {
    sockaddr_in addr{};
    socklen_t len = sizeof(addr);
    const int client_fd = ::accept(fd_, reinterpret_cast<sockaddr*>(&addr), &len);
    if (client_fd >= 0) return tcp_connection(client_fd);
    if (errno == EINTR) continue;
    throw protocol_error(errno_message("accept"));
  }
}

void tcp_listener::close() {
  close_fd(fd_);
}

tcp_connection connect_tcp(std::string_view host, std::uint16_t port,
                           int timeout_ms) {
  const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) throw protocol_error(errno_message("socket"));

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(port);
  const auto host_text = std::string(host);
  if (::inet_pton(AF_INET, host_text.c_str(), &addr.sin_addr) != 1) {
    ::close(fd);
    throw protocol_error("only IPv4 numeric hosts are supported by connect_tcp");
  }

  const int flags = ::fcntl(fd, F_GETFL, 0);
  if (flags < 0) {
    ::close(fd);
    throw protocol_error(errno_message("fcntl get"));
  }
  if (::fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0) {
    ::close(fd);
    throw protocol_error(errno_message("fcntl set nonblock"));
  }

  const int rc = ::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
  if (rc != 0 && errno != EINPROGRESS) {
    ::close(fd);
    throw protocol_error(errno_message("connect"));
  }
  wait_fd(fd, POLLOUT, timeout_ms, "socket connect");

  int error = 0;
  socklen_t len = sizeof(error);
  if (::getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &len) != 0) {
    ::close(fd);
    throw protocol_error(errno_message("getsockopt SO_ERROR"));
  }
  if (error != 0) {
    ::close(fd);
    throw protocol_error("connect failed: " + std::string(std::strerror(error)));
  }

  if (::fcntl(fd, F_SETFL, flags) != 0) {
    ::close(fd);
    throw protocol_error(errno_message("fcntl restore"));
  }

  return tcp_connection(fd);
}

}  // namespace baloot::net
