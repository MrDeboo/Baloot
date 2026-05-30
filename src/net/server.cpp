#include "net/server.hpp"

#include "core/gaid.hpp"

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <memory>
#include <optional>
#include <sstream>
#include <thread>

namespace baloot::net {
namespace {

control_message make_error(std::string code, std::string message) {
  control_message out;
  out.kind = "ERROR";
  out.fields = {{"code", std::move(code)}, {"message", std::move(message)}};
  return out;
}

control_message make_match_end(const std::string& match_id,
                               const sakkah_result& result,
                               std::string reason = "TARGET_SCORE") {
  control_message out;
  out.kind = "MATCH_END";
  out.fields = {{"match_id", match_id},
                {"winner_team", to_string(result.winner)},
                {"team_a_score", std::to_string(result.team_a_score)},
                {"team_b_score", std::to_string(result.team_b_score)},
                {"reason", std::move(reason)}};
  return out;
}

control_message make_gaid_message(const std::string& match_id, const gaid& error) {
  control_message out;
  out.kind = "GAID";
  out.fields = {{"match_id", match_id},
                {"type", error.type()},
                {"source_id", std::to_string(error.source_id())},
                {"message", error.what()},
                {"expected_cards", error.expected_cards().to_string()}};
  if (error.target_id()) {
    out.fields.emplace("target_id", std::to_string(*error.target_id()));
  }
  if (error.offending_card()) {
    out.fields.emplace("offending_card", to_string(*error.offending_card()));
  }
  return out;
}

control_message make_network_gaid_message(const std::string& match_id,
                                          int source_id,
                                          const std::string& message) {
  control_message out;
  out.kind = "GAID";
  out.fields = {{"match_id", match_id},
                {"type", "NETWORK"},
                {"source_id", std::to_string(source_id)},
                {"message", message}};
  return out;
}

bool has_gaid_log(const sakkah_result& result) {
  return std::ranges::any_of(result.log, [](const std::string& line) {
    return line.find("gaid ") != std::string::npos;
  });
}

bool timeout_error(const std::exception& error) {
  return std::string(error.what()).find("timed out") != std::string::npos;
}

bool debug_enabled(const server_options& options) {
  return options.log_level == "debug";
}

void log_info(const server_options& options, const std::string& message) {
  if (options.log_level != "quiet") {
    std::clog << "[info] " << message << '\n';
  }
}

void log_debug(const server_options& options, const std::string& message) {
  if (debug_enabled(options)) {
    std::clog << "[debug] " << message << '\n';
  }
}

void safe_send(tcp_connection& connection, const control_message& message) {
  try {
    connection.write_frame(control_to_json(message));
  } catch (...) {
  }
}

void safe_send(const std::shared_ptr<network_bot>& bot, const control_message& message) {
  try {
    bot->send_control(message);
  } catch (...) {
  }
}

sakkah_result forfeit_result(const rules_config& rules, int offender_id,
                             std::string message) {
  const auto offender_team = offender_id == 1 || offender_id == 3 ? team_id::a : team_id::b;
  const auto winner = offender_team == team_id::a ? team_id::b : team_id::a;
  sakkah_result result;
  result.team_a_score = winner == team_id::a ? rules.target_score : 0;
  result.team_b_score = winner == team_id::b ? rules.target_score : 0;
  result.games_played = 1;
  result.winner = winner;
  result.log.push_back("gaid NETWORK by player " + std::to_string(offender_id) +
                       ": " + std::move(message));
  return result;
}

}  // namespace

single_match_server::single_match_server(server_options options)
    : options_(options), listener_(options_.port) {}

std::uint16_t single_match_server::port() const {
  return listener_.port();
}

server_result single_match_server::run_once() {
  std::vector<std::shared_ptr<tcp_connection>> connections;
  std::vector<std::string> names;
  connections.reserve(4);
  names.reserve(4);

  for (int i = 0; i < 4; ++i) {
    auto conn =
        std::make_shared<tcp_connection>(listener_.accept_one(options_.accept_timeout_ms));

    const auto hello_payload =
        conn->read_frame(options_.bot.read_timeout_ms, options_.bot.max_frame_bytes);
    auto hello = control_from_json(hello_payload);
    if (hello.kind != "HELLO") {
      conn->write_frame(control_to_json(make_error("EXPECTED_HELLO",
                                                   "First frame must be HELLO.")));
      throw protocol_error("client did not send HELLO");
    }
    const auto name_it = hello.fields.find("name");
    names.push_back(name_it == hello.fields.end() ? "bot" + std::to_string(i + 1)
                                                  : name_it->second);

    control_message welcome;
    welcome.kind = "WELCOME";
    welcome.fields = {{"connection_id", "c-" + std::to_string(i + 1)},
                      {"server_version", "1"},
                      {"protocol_version", "1"}};
    conn->write_frame(control_to_json(welcome));

    const auto join_payload =
        conn->read_frame(options_.bot.read_timeout_ms, options_.bot.max_frame_bytes);
    auto join = control_from_json(join_payload);
    if (join.kind != "JOIN_LOBBY") {
      conn->write_frame(control_to_json(make_error("EXPECTED_JOIN_LOBBY",
                                                   "Second frame must be JOIN_LOBBY.")));
      throw protocol_error("client did not send JOIN_LOBBY");
    }

    connections.push_back(conn);
  }

  std::vector<std::map<std::string, std::string>> players;
  for (int i = 0; i < 4; ++i) {
    players.push_back({{"id", std::to_string(i + 1)}, {"name", names[i]}});
  }

  for (int i = 0; i < 4; ++i) {
    control_message found;
    found.kind = "MATCH_FOUND";
    found.fields = {{"match_id", match_id_}, {"self_id", std::to_string(i + 1)}};
    found.players = players;
    connections[static_cast<std::size_t>(i)]->write_frame(control_to_json(found));
  }

  std::vector<std::shared_ptr<bot_base>> bots;
  std::vector<std::shared_ptr<network_bot>> network_bots;
  for (int i = 0; i < 4; ++i) {
    auto bot = std::make_shared<network_bot>(i + 1, connections[static_cast<std::size_t>(i)],
                                             match_id_, options_.bot);
    network_bots.push_back(bot);
    bots.push_back(bot);
  }

  host game(std::move(bots), options_.game);
  auto result = game.run_sakkah();

  const auto end_message = make_match_end(match_id_, result);
  for (const auto& bot : network_bots) {
    bot->send_control(end_message);
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(25));

  return server_result{result, names};
}

lobby_server::lobby_server(server_options options)
    : options_(options), listener_(options_.port) {
  if (options_.max_concurrent_matches == 0) {
    options_.max_concurrent_matches = 1;
  }
}

std::uint16_t lobby_server::port() const {
  return listener_.port();
}

std::vector<server_result> lobby_server::run_matches(std::size_t match_count) {
  std::vector<server_result> results(match_count);
  std::vector<std::future<void>> futures;
  std::vector<lobby_client> lobby;
  lobby.reserve(4);

  std::mutex active_mutex;
  std::condition_variable active_cv;
  std::size_t active_matches = 0;

  int connection_id = 0;
  for (std::size_t match_number = 0; match_number < match_count;) {
    auto client = try_accept_client(++connection_id, true);
    if (!client) continue;
    lobby.push_back(std::move(*client));
    if (lobby.size() < 4) continue;

    std::unique_lock lock(active_mutex);
    active_cv.wait(lock, [&] {
      return active_matches < options_.max_concurrent_matches;
    });
    ++active_matches;
    lock.unlock();

    std::vector<lobby_client> group;
    group.swap(lobby);
    const auto result_index = match_number;
    const auto current_match_number = match_number + 1;
    ++match_number;

    futures.push_back(std::async(std::launch::async, [&, group = std::move(group),
                                                       result_index,
                                                       current_match_number]() mutable {
      try {
        results[result_index] = run_match(std::move(group), current_match_number);
      } catch (const std::exception& error) {
        server_result failed;
        failed.match = forfeit_result(options_.game.rules, 1, error.what());
        results[result_index] = std::move(failed);
      }

      std::lock_guard done_lock(active_mutex);
      --active_matches;
      active_cv.notify_one();
    }));
  }

  for (auto& future : futures) {
    future.get();
  }
  return results;
}

std::vector<server_result> lobby_server::run_until_stopped(
    const std::atomic_bool& stop_requested) {
  std::vector<server_result> results;
  std::vector<std::future<server_result>> futures;
  std::vector<lobby_client> lobby;
  lobby.reserve(4);

  int connection_id = 0;
  std::size_t match_number = 0;
  while (!stop_requested.load()) {
    auto client = try_accept_client(++connection_id, true);
    if (!client) {
      futures.erase(std::remove_if(futures.begin(), futures.end(), [&](auto& future) {
                      if (future.wait_for(std::chrono::milliseconds(0)) !=
                          std::future_status::ready) {
                        return false;
                      }
                      results.push_back(future.get());
                      return true;
                    }),
                    futures.end());
      continue;
    }

    lobby.push_back(std::move(*client));
    if (lobby.size() < 4) continue;

    while (futures.size() >= options_.max_concurrent_matches &&
           !stop_requested.load()) {
      for (auto it = futures.begin(); it != futures.end();) {
        if (it->wait_for(std::chrono::milliseconds(25)) == std::future_status::ready) {
          results.push_back(it->get());
          it = futures.erase(it);
        } else {
          ++it;
        }
      }
    }

    std::vector<lobby_client> group;
    group.swap(lobby);
    ++match_number;
    futures.push_back(std::async(std::launch::async, [this, group = std::move(group),
                                                       match_number]() mutable {
      return run_match(std::move(group), match_number);
    }));
  }

  log_info(options_, "shutdown requested; no new lobby clients will be accepted");
  for (auto& client : lobby) {
    control_message error;
    error.kind = "ERROR";
    error.fields = {{"code", "SERVER_SHUTDOWN"},
                    {"message", "Server is shutting down before a match was formed."}};
    safe_send(*client.connection, error);
  }
  for (auto& future : futures) {
    results.push_back(future.get());
  }
  return results;
}

std::optional<lobby_server::lobby_client> lobby_server::try_accept_client(
    int connection_id, bool allow_accept_timeout) {
  std::shared_ptr<tcp_connection> connection;
  try {
    connection =
        std::make_shared<tcp_connection>(listener_.accept_one(options_.accept_timeout_ms));
  } catch (const std::exception& error) {
    if (allow_accept_timeout && timeout_error(error)) return std::nullopt;
    throw;
  }

  const auto hello_payload =
      connection->read_frame(options_.bot.read_timeout_ms, options_.bot.max_frame_bytes);
  log_debug(options_, "frame in HELLO " + std::to_string(hello_payload.size()) + " bytes");
  auto hello = control_from_json(hello_payload);
  if (hello.kind != "HELLO") {
    safe_send(*connection, make_error("EXPECTED_HELLO", "First frame must be HELLO."));
    throw protocol_error("client did not send HELLO");
  }
  const auto name_it = hello.fields.find("name");
  auto name = name_it == hello.fields.end() ? "bot" + std::to_string(connection_id)
                                            : name_it->second;

  control_message welcome;
  welcome.kind = "WELCOME";
  welcome.fields = {{"connection_id", "c-" + std::to_string(connection_id)},
                    {"server_version", "1"},
                    {"protocol_version", "1"}};
  connection->write_frame(control_to_json(welcome));
  log_debug(options_, "frame out WELCOME");

  const auto join_payload =
      connection->read_frame(options_.bot.read_timeout_ms, options_.bot.max_frame_bytes);
  log_debug(options_, "frame in JOIN_LOBBY " + std::to_string(join_payload.size()) +
                          " bytes");
  auto join = control_from_json(join_payload);
  if (join.kind != "JOIN_LOBBY") {
    safe_send(*connection, make_error("EXPECTED_JOIN_LOBBY",
                                      "Second frame must be JOIN_LOBBY."));
    throw protocol_error("client did not send JOIN_LOBBY");
  }

  log_info(options_, "client joined lobby: " + name);
  return lobby_client{connection, std::move(name), connection_id};
}

server_result lobby_server::run_match(std::vector<lobby_client> clients,
                                      std::size_t match_number) {
  const auto match_id = "m-" + std::to_string(match_number);
  log_info(options_, "starting " + match_id + " with four clients");
  std::vector<std::string> names;
  names.reserve(clients.size());

  std::vector<std::map<std::string, std::string>> players;
  for (std::size_t i = 0; i < clients.size(); ++i) {
    names.push_back(clients[i].name);
    players.push_back({{"id", std::to_string(i + 1)}, {"name", clients[i].name}});
  }

  for (std::size_t i = 0; i < clients.size(); ++i) {
    control_message found;
    found.kind = "MATCH_FOUND";
    found.fields = {{"match_id", match_id}, {"self_id", std::to_string(i + 1)}};
    found.players = players;
    clients[i].connection->write_frame(control_to_json(found));
  }

  std::vector<std::shared_ptr<bot_base>> bots;
  std::vector<std::shared_ptr<network_bot>> network_bots;
  for (std::size_t i = 0; i < clients.size(); ++i) {
    auto bot = std::make_shared<network_bot>(static_cast<int>(i + 1),
                                             clients[i].connection, match_id,
                                             options_.bot);
    network_bots.push_back(bot);
    bots.push_back(bot);
  }

  sakkah_result result;
  std::optional<control_message> gaid_message;
  try {
    host game(std::move(bots), options_.game);
    result = game.run_sakkah();
  } catch (const gaid& error) {
    result = forfeit_result(options_.game.rules, error.source_id(), error.what());
    gaid_message = make_gaid_message(match_id, error);
  } catch (const std::exception& error) {
    result = forfeit_result(options_.game.rules, 1, error.what());
    gaid_message = make_network_gaid_message(match_id, 1, error.what());
  }

  const auto reason = has_gaid_log(result) ? "FORFEIT" : "TARGET_SCORE";
  if (reason == std::string("FORFEIT")) {
    if (!gaid_message) {
      const auto message = result.log.empty() ? "match forfeited" : result.log.front();
      gaid_message = make_network_gaid_message(match_id, 1, message);
    }
    if (gaid_message) {
      for (const auto& bot : network_bots) {
        safe_send(bot, *gaid_message);
      }
    }
    control_message error;
    error.kind = "ERROR";
    error.fields = {{"code", "MATCH_FORFEIT"},
                    {"message", "A client disconnected, timed out, or sent invalid data."}};
    for (const auto& bot : network_bots) {
      safe_send(bot, error);
    }
  }

  const auto end_message = make_match_end(match_id, result, reason);
  for (const auto& bot : network_bots) {
    safe_send(bot, end_message);
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(25));
  log_info(options_, match_id + " ended with " + reason + " A=" +
                         std::to_string(result.team_a_score) + " B=" +
                         std::to_string(result.team_b_score));

  return server_result{result, names};
}

}  // namespace baloot::net
