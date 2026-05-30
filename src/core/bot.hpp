#pragma once

#include "core/action.hpp"

#include <vector>

namespace baloot {

struct bot_base {
  virtual ~bot_base() = default;
  virtual std::vector<action> read() = 0;
  virtual void write(std::vector<action> actions) = 0;
  virtual int id() = 0;
};

}  // namespace baloot
