cmake_minimum_required(VERSION 3.24)

project(baloot_network_game LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(baloot_core
  src/core/action.cpp
  src/core/card.cpp
  src/core/cards.cpp
  src/core/host.cpp
  src/core/project.cpp
  src/core/rules.cpp
  src/core/scoring.cpp
  src/net/frame.cpp
  src/net/network_bot.cpp
  src/net/protocol.cpp
  src/net/server.cpp
  src/net/socket.cpp
  src/bots/local_bot.cpp
  src/bots/reference_client.cpp
)

target_include_directories(baloot_core PUBLIC src)

target_compile_options(baloot_core PRIVATE
  $<$<CXX_COMPILER_ID:Clang,AppleClang,GNU>:-Wall -Wextra -Wpedantic>
)

add_executable(baloot-local-smoke apps/baloot_local.cpp)
target_link_libraries(baloot-local-smoke PRIVATE baloot_core)

add_executable(baloot-server apps/baloot_server.cpp)
target_link_libraries(baloot-server PRIVATE baloot_core)

add_executable(baloot-bot apps/baloot_bot.cpp)
target_link_libraries(baloot-bot PRIVATE baloot_core)

enable_testing()

add_executable(baloot-core-tests tests/test_main.cpp)
target_link_libraries(baloot-core-tests PRIVATE baloot_core)

add_test(NAME baloot-core-tests COMMAND baloot-core-tests)
