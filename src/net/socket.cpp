#include "net/socket.hpp"

#ifdef _WIN32
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <cerrno>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

#include <algorithm>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <system_error>
#include <utility>

namespace baloot::net {
namespace {

#ifdef _WIN32
using platform_socket = SOCKET;
using socket_length = int;
constexpr platform_socket invalid_platform_socket = INVALID_SOCKET;

class winsock_runtime {
 public:
  winsock_runtime() {
    WSADATA data{};
    const int rc = ::WSAStartup(MAKEWORD(2, 2), &data);
    if (rc != 0) {
      throw protocol_error("WSAStartup failed: " +
                           std::error_code(rc, std::system_category()).message());
    }
  }

  ~winsock_runtime() {
    ::WSACleanup();
  }
};

void ensure_socket_runtime() {
  static winsock_runtime runtime;
}

platform_socket to_platform(socket_handle fd) {
  return static_cast<platform_socket>(fd);
}

socket_handle from_platform(platform_socket fd) {
  return static_cast<socket_handle>(fd);
}

int last_socket_error() {
  return ::WSAGetLastError();
}

bool interrupted_error(int error) {
  return error == WSAEINTR;
}

bool connect_in_progress(int error) {
  return error == WSAEWOULDBLOCK || error == WSAEINPROGRESS ||
         error == WSAEALREADY;
}

#else
using platform_socket = int;
using socket_length = socklen_t;
constexpr platform_socket invalid_platform_socket = -1;

void ensure_socket_runtime() {}

platform_socket to_platform(socket_handle fd) {
  return fd;
}

socket_handle from_platform(platform_socket fd) {
  return fd;
}

int last_socket_error() {
  return errno;
}

bool interrupted_error(int error) {
  return error == EINTR;
}

bool connect_in_progress(int error) {
  return error == EINPROGRESS;
}

#endif

enum class wait_kind { read, write };

std::string socket_error_message(std::string_view prefix, int error = last_socket_error()) {
  return std::string(prefix) + ": " +
         std::error_code(error, std::system_category()).message();
}

bool is_invalid(platform_socket fd) {
  return fd == invalid_platform_socket;
}

platform_socket make_socket() {
  ensure_socket_runtime();
  return ::socket(AF_INET, SOCK_STREAM, 0);
}

void close_fd(socket_handle& fd) {
  if (fd == invalid_socket_handle) return;
#ifdef _WIN32
  ::closesocket(to_platform(fd));
#else
  ::close(to_platform(fd));
#endif
  fd = invalid_socket_handle;
}

void close_platform_socket(platform_socket fd) {
  if (is_invalid(fd)) return;
#ifdef _WIN32
  ::closesocket(fd);
#else
  ::close(fd);
#endif
}

int socket_error_option(socket_handle fd) {
  int error = 0;
  socket_length len = sizeof(error);
  if (::getsockopt(to_platform(fd), SOL_SOCKET, SO_ERROR,
#ifdef _WIN32
                   reinterpret_cast<char*>(&error),
#else
                   &error,
#endif
                   &len) != 0) {
    throw protocol_error(socket_error_message("getsockopt SO_ERROR"));
  }
  return error;
}

void wait_fd(socket_handle fd, wait_kind kind, int timeout_ms, std::string_view action) {
  const auto raw = to_platform(fd);
  while (true) {
    fd_set read_set;
    fd_set write_set;
    fd_set error_set;
    FD_ZERO(&read_set);
    FD_ZERO(&write_set);
    FD_ZERO(&error_set);

    if (kind == wait_kind::read) {
      FD_SET(raw, &read_set);
    } else {
      FD_SET(raw, &write_set);
    }
    FD_SET(raw, &error_set);

    timeval timeout{};
    timeval* timeout_ptr = nullptr;
    if (timeout_ms >= 0) {
      timeout.tv_sec = timeout_ms / 1000;
      timeout.tv_usec = (timeout_ms % 1000) * 1000;
      timeout_ptr = &timeout;
    }

#ifdef _WIN32
    const int rc = ::select(0, &read_set, &write_set, &error_set, timeout_ptr);
#else
    const int rc = ::select(raw + 1, &read_set, &write_set, &error_set, timeout_ptr);
#endif
    if (rc > 0) {
      if (FD_ISSET(raw, &error_set)) {
        const int error = socket_error_option(fd);
        if (error != 0) throw protocol_error(socket_error_message(action, error));
        throw protocol_error(std::string(action) + " failed: socket closed");
      }
      return;
    }
    if (rc == 0) throw protocol_error(std::string(action) + " timed out");

    const int error = last_socket_error();
    if (interrupted_error(error)) continue;
    throw protocol_error(socket_error_message(action, error));
  }
}

void set_reuseaddr(socket_handle fd) {
  int yes = 1;
  if (::setsockopt(to_platform(fd), SOL_SOCKET, SO_REUSEADDR,
#ifdef _WIN32
                   reinterpret_cast<const char*>(&yes),
#else
                   &yes,
#endif
                   sizeof(yes)) != 0) {
    throw protocol_error(socket_error_message("setsockopt SO_REUSEADDR"));
  }
}

void set_no_sigpipe(socket_handle fd) noexcept {
#if defined(SO_NOSIGPIPE)
  int yes = 1;
  (void)::setsockopt(to_platform(fd), SOL_SOCKET, SO_NOSIGPIPE, &yes,
                     sizeof(yes));
#else
  (void)fd;
#endif
}

void set_nonblocking(socket_handle fd, bool enabled) {
#ifdef _WIN32
  u_long mode = enabled ? 1UL : 0UL;
  if (::ioctlsocket(to_platform(fd), FIONBIO, &mode) != 0) {
    throw protocol_error(socket_error_message(enabled ? "ioctlsocket nonblock"
                                                     : "ioctlsocket blocking"));
  }
#else
  const int flags = ::fcntl(to_platform(fd), F_GETFL, 0);
  if (flags < 0) throw protocol_error(socket_error_message("fcntl get"));
  const int next = enabled ? (flags | O_NONBLOCK) : (flags & ~O_NONBLOCK);
  if (::fcntl(to_platform(fd), F_SETFL, next) != 0) {
    throw protocol_error(socket_error_message(enabled ? "fcntl set nonblock"
                                                     : "fcntl set blocking"));
  }
#endif
}

#ifndef _WIN32
int socket_flags(socket_handle fd) {
  const int flags = ::fcntl(to_platform(fd), F_GETFL, 0);
  if (flags < 0) throw protocol_error(socket_error_message("fcntl get"));
  return flags;
}

void restore_socket_flags(socket_handle fd, int flags) {
  if (::fcntl(to_platform(fd), F_SETFL, flags) != 0) {
    throw protocol_error(socket_error_message("fcntl restore"));
  }
}
#endif

int parse_ipv4_address(const char* host, in_addr* out) {
#ifdef _WIN32
  return ::InetPtonA(AF_INET, host, out);
#else
  return ::inet_pton(AF_INET, host, out);
#endif
}

}  // namespace

tcp_connection::tcp_connection(socket_handle fd) : fd_(fd) {
  if (valid()) set_no_sigpipe(fd_);
}

tcp_connection::tcp_connection(tcp_connection&& other) noexcept
    : fd_(other.fd_), read_buffer_(std::move(other.read_buffer_)) {
  other.fd_ = invalid_socket_handle;
}

tcp_connection& tcp_connection::operator=(tcp_connection&& other) noexcept {
  if (this != &other) {
    close();
    fd_ = other.fd_;
    read_buffer_ = std::move(other.read_buffer_);
    other.fd_ = invalid_socket_handle;
  }
  return *this;
}

tcp_connection::~tcp_connection() {
  close();
}

bool tcp_connection::valid() const {
  return fd_ != invalid_socket_handle;
}

socket_handle tcp_connection::fd() const {
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

    wait_fd(fd_, wait_kind::read, timeout_ms, "socket read");
    char buffer[4096];
    const auto n = ::recv(to_platform(fd_), buffer, static_cast<int>(sizeof(buffer)), 0);
    if (n > 0) {
      read_buffer_.append(buffer, static_cast<std::size_t>(n));
      continue;
    }
    if (n == 0) throw protocol_error("socket read failed: peer disconnected");

    const int error = last_socket_error();
    if (interrupted_error(error)) continue;
    throw protocol_error(socket_error_message("socket read", error));
  }
}

void tcp_connection::write_frame(std::string_view payload) {
  if (!valid()) throw protocol_error("write on closed socket");
  const auto frame = encode_frame(payload);
  std::size_t written = 0;
  while (written < frame.size()) {
    const auto remaining = frame.size() - written;
    const auto chunk =
        std::min<std::size_t>(remaining, static_cast<std::size_t>(
                                             std::numeric_limits<int>::max()));
    const auto n = ::send(to_platform(fd_), frame.data() + written,
                          static_cast<int>(chunk),
#ifdef MSG_NOSIGNAL
                          MSG_NOSIGNAL
#else
                          0
#endif
    );
    if (n > 0) {
      written += static_cast<std::size_t>(n);
      continue;
    }
    if (n == 0) throw protocol_error("socket write failed: socket closed");

    const int error = last_socket_error();
    if (interrupted_error(error)) continue;
    throw protocol_error(socket_error_message("socket write", error));
  }
}

tcp_listener::tcp_listener(std::uint16_t port) {
  const auto raw = make_socket();
  if (is_invalid(raw)) throw protocol_error(socket_error_message("socket"));
  fd_ = from_platform(raw);
  try {
    set_reuseaddr(fd_);
    set_no_sigpipe(fd_);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(port);
    if (::bind(raw, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
      throw protocol_error(socket_error_message("bind"));
    }
    if (::listen(raw, 16) != 0) {
      throw protocol_error(socket_error_message("listen"));
    }

    sockaddr_in actual{};
    socket_length len = sizeof(actual);
    if (::getsockname(raw, reinterpret_cast<sockaddr*>(&actual), &len) != 0) {
      throw protocol_error(socket_error_message("getsockname"));
    }
    port_ = ntohs(actual.sin_port);
  } catch (...) {
    close();
    throw;
  }
}

tcp_listener::tcp_listener(tcp_listener&& other) noexcept
    : fd_(other.fd_), port_(other.port_) {
  other.fd_ = invalid_socket_handle;
  other.port_ = 0;
}

tcp_listener& tcp_listener::operator=(tcp_listener&& other) noexcept {
  if (this != &other) {
    close();
    fd_ = other.fd_;
    port_ = other.port_;
    other.fd_ = invalid_socket_handle;
    other.port_ = 0;
  }
  return *this;
}

tcp_listener::~tcp_listener() {
  close();
}

bool tcp_listener::valid() const {
  return fd_ != invalid_socket_handle;
}

socket_handle tcp_listener::fd() const {
  return fd_;
}

std::uint16_t tcp_listener::port() const {
  return port_;
}

tcp_connection tcp_listener::accept_one(int timeout_ms) {
  if (!valid()) throw protocol_error("accept on closed listener");
  if (timeout_ms >= 0) wait_fd(fd_, wait_kind::read, timeout_ms, "socket accept");
  while (true) {
    sockaddr_in addr{};
    socket_length len = sizeof(addr);
    const auto client_fd =
        ::accept(to_platform(fd_), reinterpret_cast<sockaddr*>(&addr), &len);
    if (!is_invalid(client_fd)) return tcp_connection(from_platform(client_fd));

    const int error = last_socket_error();
    if (interrupted_error(error)) continue;
    throw protocol_error(socket_error_message("accept", error));
  }
}

void tcp_listener::close() {
  close_fd(fd_);
}

tcp_connection connect_tcp(std::string_view host, std::uint16_t port,
                           int timeout_ms) {
  const auto raw = make_socket();
  if (is_invalid(raw)) throw protocol_error(socket_error_message("socket"));
  const auto handle = from_platform(raw);

  try {
    set_no_sigpipe(handle);

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port);
    const auto host_text = std::string(host);
    if (parse_ipv4_address(host_text.c_str(), &addr.sin_addr) != 1) {
      throw protocol_error("only IPv4 numeric hosts are supported by connect_tcp");
    }

#ifdef _WIN32
    set_nonblocking(handle, true);
#else
    const int old_flags = socket_flags(handle);
    set_nonblocking(handle, true);
#endif

    const int rc = ::connect(raw, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
    if (rc != 0) {
      const int error = last_socket_error();
      if (!connect_in_progress(error)) {
        throw protocol_error(socket_error_message("connect", error));
      }
      wait_fd(handle, wait_kind::write, timeout_ms, "socket connect");
    }

    const int error = socket_error_option(handle);
    if (error != 0) {
      throw protocol_error(socket_error_message("connect failed", error));
    }

#ifdef _WIN32
    set_nonblocking(handle, false);
#else
    restore_socket_flags(handle, old_flags);
#endif

    return tcp_connection(handle);
  } catch (...) {
    close_platform_socket(raw);
    throw;
  }
}

}  // namespace baloot::net
