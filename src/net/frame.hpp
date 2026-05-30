#pragma once

#include "net/protocol.hpp"

#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

namespace baloot::net {

struct decoded_frame {
  std::string payload;
  std::size_t bytes_consumed{};
};

std::string encode_frame(std::string_view payload);
std::optional<decoded_frame> try_decode_frame(std::string_view buffer,
                                              std::size_t max_frame_bytes = 64 * 1024);

}  // namespace baloot::net
