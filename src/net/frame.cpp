#include "net/frame.hpp"

#include <charconv>
#include <cctype>
#include <limits>
#include <sstream>

namespace baloot::net {

std::string encode_frame(std::string_view payload) {
  std::ostringstream out;
  out << payload.size() << '\n' << payload << '\n';
  return out.str();
}

std::optional<decoded_frame> try_decode_frame(std::string_view buffer,
                                              std::size_t max_frame_bytes) {
  const auto newline = buffer.find('\n');
  if (newline == std::string_view::npos) return std::nullopt;
  if (newline == 0) throw protocol_error("empty frame length");

  for (std::size_t i = 0; i < newline; ++i) {
    if (!std::isdigit(static_cast<unsigned char>(buffer[i]))) {
      throw protocol_error("frame length contains non-digit");
    }
  }

  std::size_t length = 0;
  const auto header = buffer.substr(0, newline);
  auto [ptr, ec] = std::from_chars(header.data(), header.data() + header.size(), length);
  if (ec != std::errc{} || ptr != header.data() + header.size()) {
    throw protocol_error("invalid frame length");
  }
  if (length > max_frame_bytes) {
    throw protocol_error("frame length exceeds configured maximum");
  }

  const auto payload_start = newline + 1;
  const auto trailing_newline = payload_start + length;
  const auto needed = trailing_newline + 1;
  if (buffer.size() < needed) return std::nullopt;
  if (buffer[trailing_newline] != '\n') {
    throw protocol_error("frame payload missing trailing newline");
  }

  return decoded_frame{std::string(buffer.substr(payload_start, length)), needed};
}

}  // namespace baloot::net
