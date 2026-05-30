#include "bots/local_bot.hpp"
#include "bots/reference_client.hpp"
#include "core/action.hpp"
#include "core/card.hpp"
#include "core/cards.hpp"
#include "core/gaid.hpp"
#include "core/host.hpp"
#include "core/project.hpp"
#include "core/rules.hpp"
#include "core/scoring.hpp"
#include "net/frame.hpp"
#include "net/protocol.hpp"
#include "net/server.hpp"

#include <chrono>
#include <cstdlib>
#include <deque>
#include <future>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {

int failures = 0;

void require(bool condition, const std::string& message) {
  if (!condition) {
    ++failures;
    std::cerr << "FAIL: " << message << '\n';
  }
}

template <typename Fn>
void test(const std::string& name, Fn fn) {
  try {
    fn();
    std::cerr << "PASS: " << name << '\n';
  } catch (const std::exception& error) {
    ++failures;
    std::cerr << "FAIL: " << name << ": " << error.what() << '\n';
  }
}

baloot::card c(std::string_view text) {
  auto parsed = baloot::parse_card(text);
  if (!parsed) throw std::runtime_error("bad test card");
  return *parsed;
}

struct malformed_client_result {
  baloot::reference_client_result final;
  bool saw_gaid{};
  bool saw_error{};
};

void run_disconnect_client(std::uint16_t port) {
  auto connection = baloot::net::connect_tcp("127.0.0.1", port, 10000);
  baloot::net::control_message hello;
  hello.kind = "HELLO";
  hello.fields = {{"name", "disconnecting-bot"}, {"version", "1"}, {"token", ""}};
  connection.write_frame(baloot::net::control_to_json(hello));
  auto welcome = baloot::net::control_from_json(connection.read_frame(10000, 64 * 1024));
  require(welcome.kind == "WELCOME", "disconnect client welcomed");

  baloot::net::control_message join;
  join.kind = "JOIN_LOBBY";
  connection.write_frame(baloot::net::control_to_json(join));
  auto found = baloot::net::control_from_json(connection.read_frame(10000, 64 * 1024));
  require(found.kind == "MATCH_FOUND", "disconnect client matched");
  connection.close();
}

malformed_client_result run_malformed_client(std::uint16_t port) {
  auto connection = baloot::net::connect_tcp("127.0.0.1", port, 10000);
  baloot::net::control_message hello;
  hello.kind = "HELLO";
  hello.fields = {{"name", "malformed-bot"}, {"version", "1"}, {"token", ""}};
  connection.write_frame(baloot::net::control_to_json(hello));
  auto welcome = baloot::net::control_from_json(connection.read_frame(10000, 64 * 1024));
  require(welcome.kind == "WELCOME", "malformed client welcomed");

  baloot::net::control_message join;
  join.kind = "JOIN_LOBBY";
  connection.write_frame(baloot::net::control_to_json(join));
  auto found = baloot::net::control_from_json(connection.read_frame(10000, 64 * 1024));
  require(found.kind == "MATCH_FOUND", "malformed client matched");

  connection.write_frame("{not-json");

  malformed_client_result result;
  while (true) {
    const auto payload = connection.read_frame(10000, 64 * 1024);
    const auto kind = baloot::net::message_kind(payload);
    if (kind == "ACTIONS") continue;
    auto control = baloot::net::control_from_json(payload);
    if (control.kind == "GAID") {
      result.saw_gaid = true;
      continue;
    }
    if (control.kind == "ERROR") {
      result.saw_error = true;
      continue;
    }
    if (control.kind == "MATCH_END") {
      result.final.self_id = std::stoi(found.fields.at("self_id"));
      result.final.team_a_score = std::stoi(control.fields.at("team_a_score"));
      result.final.team_b_score = std::stoi(control.fields.at("team_b_score"));
      auto winner = baloot::parse_team_id(control.fields.at("winner_team"));
      if (winner) result.final.winner = *winner;
      return result;
    }
  }
}

class scripted_bot : public baloot::bot_base {
 public:
  scripted_bot(int id, std::deque<baloot::action> scripted)
      : delegate_(id, static_cast<unsigned int>(5000 + id)),
        scripted_(std::move(scripted)) {}

  std::vector<baloot::action> read() override {
    if (!scripted_.empty()) {
      auto next = scripted_.front();
      scripted_.pop_front();
      return {next};
    }
    return delegate_.read();
  }

  void write(std::vector<baloot::action> actions) override {
    for (const auto& item : actions) {
      if (item.type == baloot::action_type::buy_call) {
        if (auto call = item.maybe("call")) buy_calls_.push_back(*call);
      }
    }
    delegate_.write(std::move(actions));
  }

  int id() override { return delegate_.id(); }

  const std::vector<std::string>& buy_calls() const { return buy_calls_; }

 private:
  baloot::local_bot delegate_;
  std::deque<baloot::action> scripted_;
  std::vector<std::string> buy_calls_;
};

baloot::sakkah_result run_scripted_sakkah(
    std::shared_ptr<scripted_bot> one,
    std::shared_ptr<scripted_bot> two,
    std::shared_ptr<scripted_bot> three,
    std::shared_ptr<scripted_bot> four) {
  std::vector<std::shared_ptr<baloot::bot_base>> bots{one, two, three, four};
  baloot::host_options options;
  options.rules.target_score = 32;
  options.seed = 424242;
  baloot::host game(std::move(bots), options);
  return game.run_sakkah();
}

bool log_contains(const baloot::sakkah_result& result, std::string_view needle) {
  for (const auto& line : result.log) {
    if (line.find(needle) != std::string::npos) return true;
  }
  return false;
}

}  // namespace

int main() {
  using namespace baloot;

  test("card parse and points", [] {
    require(to_string(c("AS")) == "AS", "ace spades string");
    require(to_string(c("10H")) == "10H", "ten hearts string");
    require(sun_points(c("AS")) == 11, "sun ace points");
    require(sun_points(c("JH")) == 2, "sun jack points");
    require(hukum_points(c("JH"), suit::hearts) == 20, "hukum jack points");
    require(hukum_points(c("9H"), suit::hearts) == 14, "hukum nine points");
    require(hukum_points(c("9C"), suit::hearts) == 0, "non-trump nine points");
    require(sun_strength(rank::ace) > sun_strength(rank::ten), "sun order");
    require(hukum_trump_strength(rank::jack) > hukum_trump_strength(rank::nine),
            "hukum order");
  });

  test("deck and cards strings", [] {
    auto deck = make_deck_32();
    require(deck.size() == 32, "32-card deck");
    require(deck.contains(c("7C")), "deck has 7C");
    require(deck.contains(c("AS")), "deck has AS");
    auto hand = parse_cards("AS 10H JD 7C");
    require(hand.size() == 4, "parse four cards");
    require(hand.to_string() == "AS 10H JD 7C", "card list round trip");
  });

  test("action conversion", [] {
    for (auto type : {action_type::new_sakkah, action_type::new_game,
                      action_type::deal_1, action_type::middle_card,
                      action_type::buy_call, action_type::deal_2,
                      action_type::state_project, action_type::show_project,
                      action_type::play_card, action_type::ikkah,
                      action_type::baloot}) {
      auto text = to_string(type);
      auto parsed = parse_action_type(text);
      require(parsed && *parsed == type, "action type round trip " + text);
    }
    action a = make_action(1, action_type::play_card, {{"card", "AS"}});
    require(a.valid(), "action valid");
    require(a["card"] == "AS", "action data accessor");
  });

  test("serialization round trips every action type", [] {
    std::vector<action_type> types{action_type::new_sakkah, action_type::new_game,
                                   action_type::deal_1, action_type::middle_card,
                                   action_type::buy_call, action_type::deal_2,
                                   action_type::state_project,
                                   action_type::show_project,
                                   action_type::play_card, action_type::ikkah,
                                   action_type::baloot};
    for (std::size_t i = 0; i < types.size(); ++i) {
      action original = make_action(static_cast<int>(i + 1), types[i],
                                    {{"self_id", std::to_string(i + 1)},
                                     {"message", "quote \" slash \\ newline\n tab\t"},
                                     {"empty", ""}});
      const auto json = net::action_to_json(original);
      auto parsed = net::action_from_json(json);
      require(parsed.actor_id == original.actor_id, "serialized actor id");
      require(parsed.type == original.type, "serialized type " + to_string(original.type));
      require(parsed.data == original.data, "serialized data " + to_string(original.type));
    }

    action empty = make_action(0, action_type::new_sakkah, {});
    require(net::action_from_json(net::action_to_json(empty)).data.empty(),
            "empty action data round trip");
  });

  test("action envelope serialization", [] {
    net::action_envelope original;
    original.seq = 42;
    original.match_id = "m-1";
    original.actions = {make_action(1, action_type::play_card, {{"card", "AS"}}),
                        make_action(2, action_type::ikkah, {{"type", "AUTO"}})};
    const auto json = net::envelope_to_json(original);
    auto parsed = net::envelope_from_json(json);
    require(parsed.seq == original.seq, "envelope seq");
    require(parsed.match_id == original.match_id, "envelope match id");
    require(parsed.actions.size() == 2, "envelope actions count");
    require(parsed.actions[0].data["card"] == "AS", "envelope action data");
  });

  test("control message serialization", [] {
    net::control_message hello;
    hello.kind = "HELLO";
    hello.fields = {{"name", "bot \"one\""}, {"version", "1"}, {"token", ""}};
    auto hello_round = net::control_from_json(net::control_to_json(hello));
    require(hello_round.kind == "HELLO", "hello kind");
    require(hello_round.fields == hello.fields, "hello fields");

    net::control_message found;
    found.kind = "MATCH_FOUND";
    found.fields = {{"match_id", "m-000001"}, {"self_id", "2"}};
    found.players = {{{"id", "1"}, {"name", "bot-a"}},
                     {{"id", "2"}, {"name", "bot-b"}}};
    auto found_round = net::control_from_json(net::control_to_json(found));
    require(found_round.kind == found.kind, "match found kind");
    require(found_round.fields == found.fields, "match found fields");
    require(found_round.players == found.players, "match found players");

    net::control_message gaid_message;
    gaid_message.kind = "GAID";
    gaid_message.fields = {{"type", "INVALID_CUT"},
                           {"source_id", "3"},
                           {"offending_card", "7C"},
                           {"expected_cards", "AH 10H"},
                           {"message", "had to follow suit"}};
    auto gaid_round = net::control_from_json(net::control_to_json(gaid_message));
    require(gaid_round.fields == gaid_message.fields, "gaid fields");
  });

  test("length frames", [] {
    const std::string payload = "{\"kind\":\"PING\",\"nonce\":\"abc\"}";
    const auto frame = net::encode_frame(payload);
    auto partial = net::try_decode_frame(std::string_view(frame).substr(0, frame.size() - 1));
    require(!partial, "partial frame waits for more bytes");
    auto decoded = net::try_decode_frame(frame);
    require(decoded.has_value(), "frame decoded");
    require(decoded->payload == payload, "frame payload");
    require(decoded->bytes_consumed == frame.size(), "frame consumed size");

    bool too_large = false;
    try {
      (void)net::try_decode_frame(frame, 4);
    } catch (const net::protocol_error&) {
      too_large = true;
    }
    require(too_large, "frame max-size guard");
  });

  test("project validation", [] {
    auto hand = parse_cards("7H 8H 9H 10H JH AS AC AD AH");
    auto sira = validate_project(1, hand, project_kind::sira,
                                 parse_cards("7H 8H 9H"), game_mode::sun);
    require(sira.score == 4, "sun sira score");
    auto fifty = validate_project(1, hand, project_kind::fifty,
                                  parse_cards("7H 8H 9H 10H"), game_mode::hukum);
    require(fifty.score == 5, "hukum fifty score");
    auto hundred = validate_project(1, hand, project_kind::hundred,
                                    parse_cards("7H 8H 9H 10H JH"), game_mode::sun);
    require(hundred.score == 20, "sun hundred score");
    auto four_hundred = validate_project(1, hand, project_kind::four_hundred,
                                         parse_cards("AS AC AD AH"), game_mode::sun);
    require(four_hundred.score == 40, "four hundred score");
    bool rejected = false;
    try {
      (void)validate_project(1, hand, project_kind::four_hundred,
                             parse_cards("AS AC AD AH"), game_mode::hukum);
    } catch (const invalid_action&) {
      rejected = true;
    }
    require(rejected, "four hundred rejected in hukum");
  });

  test("trick winner resolution", [] {
    std::vector<trick_play> sun_plays{
        {1, c("7H")}, {2, c("AH")}, {3, c("10H")}, {4, c("JH")}};
    require(winning_play_index(sun_plays, game_mode::sun, std::nullopt) == 1,
            "sun ace wins");

    std::vector<trick_play> hukum_plays{
        {1, c("AH")}, {2, c("7S")}, {3, c("JH")}, {4, c("9H")}};
    require(winning_play_index(hukum_plays, game_mode::hukum, suit::hearts) == 2,
            "hukum jack trump wins");
  });

  test("gaid invalid cut", [] {
    auto hand = parse_cards("AH 7S 8S");
    trick_context context;
    context.mode = game_mode::sun;
    context.player_id = 2;
    context.plays = {{1, c("7H")}};
    bool rejected = false;
    try {
      validate_play_or_throw(hand, c("7S"), context);
    } catch (const invalid_cut&) {
      rejected = true;
    }
    require(rejected, "invalid cut rejected");
  });

  test("gaid did not knock", [] {
    auto hand = parse_cards("7C 9H");
    trick_context context;
    context.mode = game_mode::hukum;
    context.trump = suit::hearts;
    context.player_id = 2;
    context.team_of = [](int id) { return id % 2 == 1 ? team_id::a : team_id::b; };
    context.plays = {{1, c("AS")}};
    bool rejected = false;
    try {
      validate_play_or_throw(hand, c("7C"), context);
    } catch (const didnt_knock&) {
      rejected = true;
    }
    require(rejected, "did not knock rejected");
  });

  test("gaid trump initiation", [] {
    auto hand = parse_cards("7H AC");
    trick_context context;
    context.mode = game_mode::hukum;
    context.trump = suit::hearts;
    context.closed = true;
    context.player_id = 1;
    bool rejected = false;
    try {
      validate_play_or_throw(hand, c("7H"), context);
    } catch (const trump_initiation&) {
      rejected = true;
    }
    require(rejected, "closed hukum trump initiation rejected");
  });

  test("gaid did not go higher", [] {
    auto hand = parse_cards("JH 7H");
    trick_context context;
    context.mode = game_mode::hukum;
    context.trump = suit::hearts;
    context.player_id = 2;
    context.team_of = [](int id) { return id % 2 == 1 ? team_id::a : team_id::b; };
    context.plays = {{1, c("9H")}};
    bool rejected = false;
    try {
      validate_play_or_throw(hand, c("7H"), context);
    } catch (const didnt_go_higher&) {
      rejected = true;
    }
    require(rejected, "lower trump rejected when higher trump available");
  });

  test("scoring conversion", [] {
    require(rounded_hukum_game_points(84) == 8, "hukum 84 rounds to 8");
    require(rounded_hukum_game_points(86) == 9, "hukum 86 rounds to 9");
    require(rounded_sun_game_points(65) == 13, "sun 65 keeps half division");
    require(rounded_sun_game_points(66) == 14, "sun 66 rounds to 14");

    contract buy;
    buy.mode = game_mode::sun;
    buy.buyer_team = team_id::a;
    auto score = score_completed_game(buy, 80, 50, 0, 0, rules_config{});
    require(score.team_a_points > 0, "declarer scores when made");

    buy.gahwa = true;
    rules_config rules;
    rules.target_score = 88;
    auto gahwa_score = score_completed_game(buy, 80, 50, 0, 0, rules);
    require(gahwa_score.team_a_points == 88, "gahwa awards target score");
  });

  test("host handles gablak discussion", [] {
    auto one = std::make_shared<scripted_bot>(1, std::deque<action>{});
    auto two = std::make_shared<scripted_bot>(2, std::deque<action>{});
    auto three = std::make_shared<scripted_bot>(3, std::deque<action>{});
    auto four = std::make_shared<scripted_bot>(
        4, std::deque<action>{make_action(4, action_type::buy_call,
                                          {{"call", "GABLAK_SUN"}})});
    auto result = run_scripted_sakkah(one, two, three, four);
    require(log_contains(result, "gablak GABLAK_SUN"), "gablak logged");
    require(!log_contains(result, "gaid "), "gablak scripted game has no gaid");
  });

  test("host handles betting discussion", [] {
    auto one = std::make_shared<scripted_bot>(1, std::deque<action>{});
    auto two = std::make_shared<scripted_bot>(2, std::deque<action>{});
    auto three = std::make_shared<scripted_bot>(3, std::deque<action>{});
    auto four = std::make_shared<scripted_bot>(
        4, std::deque<action>{make_action(4, action_type::buy_call,
                                          {{"call", "BET_OPEN"}})});
    auto result = run_scripted_sakkah(one, two, three, four);
    require(log_contains(result, "bet BET_OPEN"), "bet open logged");
    require(!log_contains(result, "gaid "), "bet scripted game has no gaid");
  });

  test("host handles hukum enforce flip", [] {
    auto one = std::make_shared<scripted_bot>(
        1, std::deque<action>{
               make_action(1, action_type::buy_call, {{"call", "HUKUM"}}),
               make_action(1, action_type::buy_call, {{"call", "ENFORCE_SUN"}})});
    auto two = std::make_shared<scripted_bot>(2, std::deque<action>{});
    auto three = std::make_shared<scripted_bot>(3, std::deque<action>{});
    auto four = std::make_shared<scripted_bot>(4, std::deque<action>{});
    auto result = run_scripted_sakkah(one, two, three, four);
    require(log_contains(result, "enforced HUKUM to SUN"), "enforce flip logged");
    require(!log_contains(result, "gaid "), "enforce scripted game has no gaid");
  });

  test("in-process sakkah smoke", [] {
    std::vector<std::shared_ptr<bot_base>> bots;
    bots.push_back(std::make_shared<local_bot>(1, 111));
    bots.push_back(std::make_shared<local_bot>(2, 222));
    bots.push_back(std::make_shared<local_bot>(3, 333));
    bots.push_back(std::make_shared<local_bot>(4, 444));
    host_options options;
    options.rules.target_score = 32;
    options.seed = 20260530;
    host game(std::move(bots), options);
    auto result = game.run_sakkah();
    require(result.games_played > 0, "played at least one game");
    require(result.team_a_score >= options.rules.target_score ||
                result.team_b_score >= options.rules.target_score,
            "target reached");
    require(!result.log.empty(), "human-readable log produced");
    for (const auto& line : result.log) {
      require(line.find("gaid ") == std::string::npos, "smoke game has no gaid");
    }
  });

  test("loopback network sakkah smoke", [] {
    net::server_options server_options;
    server_options.port = 0;
    server_options.game.rules.target_score = 32;
    server_options.game.seed = 606060;
    server_options.bot.read_timeout_ms = 10000;
    server_options.log_level = "quiet";

    net::single_match_server server(server_options);
    const auto port = server.port();

    auto server_future = std::async(std::launch::async, [&] {
      return server.run_once();
    });

    std::this_thread::sleep_for(std::chrono::milliseconds(50));

    std::vector<std::future<reference_client_result>> clients;
    for (int i = 0; i < 4; ++i) {
      clients.push_back(std::async(std::launch::async, [port, i] {
        reference_client_options options;
        options.port = port;
        options.name = "loopback-bot-" + std::to_string(i + 1);
        options.seed = static_cast<unsigned int>(900 + i);
        options.read_timeout_ms = 10000;
        return run_reference_client(options);
      }));
    }

    auto server_result = server_future.get();
    require(server_result.match.games_played > 0, "network match played games");
    require(server_result.match.team_a_score >= server_options.game.rules.target_score ||
                server_result.match.team_b_score >= server_options.game.rules.target_score,
            "network match target reached");
    require(server_result.client_names.size() == 4, "server saw four client names");
    for (const auto& line : server_result.match.log) {
      require(line.find("gaid ") == std::string::npos, "network smoke has no gaid");
    }

    for (auto& client : clients) {
      auto result = client.get();
      require(result.team_a_score == server_result.match.team_a_score,
              "client saw team A final score");
      require(result.team_b_score == server_result.match.team_b_score,
              "client saw team B final score");
      require(result.winner == server_result.match.winner, "client saw winner");
    }
  });

  test("lobby runs concurrent network matches", [] {
    net::server_options server_options;
    server_options.port = 0;
    server_options.game.rules.target_score = 32;
    server_options.game.seed = 707070;
    server_options.max_concurrent_matches = 2;
    server_options.bot.read_timeout_ms = 10000;
    server_options.log_level = "quiet";

    net::lobby_server server(server_options);
    const auto port = server.port();

    auto server_future = std::async(std::launch::async, [&] {
      return server.run_matches(2);
    });

    std::this_thread::sleep_for(std::chrono::milliseconds(50));

    std::vector<std::future<reference_client_result>> clients;
    for (int i = 0; i < 8; ++i) {
      clients.push_back(std::async(std::launch::async, [port, i] {
        reference_client_options options;
        options.port = port;
        options.name = "concurrent-bot-" + std::to_string(i + 1);
        options.seed = static_cast<unsigned int>(1200 + i);
        options.read_timeout_ms = 10000;
        return run_reference_client(options);
      }));
    }

    auto server_results = server_future.get();
    require(server_results.size() == 2, "two match results");
    for (const auto& result : server_results) {
      require(result.match.team_a_score >= server_options.game.rules.target_score ||
                  result.match.team_b_score >= server_options.game.rules.target_score,
              "concurrent match target reached");
      require(result.client_names.size() == 4, "concurrent match has four clients");
      for (const auto& line : result.match.log) {
        require(line.find("gaid ") == std::string::npos,
                "concurrent match has no gaid");
      }
    }

    for (auto& client : clients) {
      auto result = client.get();
      require(result.team_a_score >= server_options.game.rules.target_score ||
                  result.team_b_score >= server_options.game.rules.target_score,
              "concurrent client received final standings");
    }
  });

  test("disconnecting client forfeits one match cleanly", [] {
    net::server_options server_options;
    server_options.port = 0;
    server_options.game.rules.target_score = 32;
    server_options.game.seed = 808080;
    server_options.bot.read_timeout_ms = 1000;
    server_options.log_level = "quiet";

    net::lobby_server server(server_options);
    const auto port = server.port();

    auto server_future = std::async(std::launch::async, [&] {
      return server.run_matches(1);
    });

    std::this_thread::sleep_for(std::chrono::milliseconds(50));

    auto bad_client = std::async(std::launch::async, [port] {
      run_disconnect_client(port);
    });

    std::vector<std::future<reference_client_result>> clients;
    for (int i = 0; i < 3; ++i) {
      clients.push_back(std::async(std::launch::async, [port, i] {
        reference_client_options options;
        options.port = port;
        options.name = "survivor-bot-" + std::to_string(i + 1);
        options.seed = static_cast<unsigned int>(2000 + i);
        options.read_timeout_ms = 10000;
        return run_reference_client(options);
      }));
    }

    bad_client.get();
    auto server_results = server_future.get();
    require(server_results.size() == 1, "one disconnect match result");
    require(server_results[0].match.team_a_score >= server_options.game.rules.target_score ||
                server_results[0].match.team_b_score >= server_options.game.rules.target_score,
            "disconnect forfeit reaches target for the winning team");
    bool saw_gaid = false;
    for (const auto& line : server_results[0].match.log) {
      if (line.find("gaid ") != std::string::npos) saw_gaid = true;
    }
    require(saw_gaid, "disconnect match logs gaid/forfeit");

    for (auto& client : clients) {
      auto result = client.get();
      require(result.team_a_score == server_results[0].match.team_a_score,
              "survivor received forfeit team A score");
      require(result.team_b_score == server_results[0].match.team_b_score,
              "survivor received forfeit team B score");
      require(result.winner == server_results[0].match.winner,
              "survivor received forfeit winner");
    }
  });

  test("malformed client does not affect concurrent match", [] {
    net::server_options server_options;
    server_options.port = 0;
    server_options.game.rules.target_score = 32;
    server_options.game.seed = 909090;
    server_options.max_concurrent_matches = 2;
    server_options.bot.read_timeout_ms = 1000;
    server_options.log_level = "quiet";

    net::lobby_server server(server_options);
    const auto port = server.port();

    auto server_future = std::async(std::launch::async, [&] {
      return server.run_matches(2);
    });

    std::this_thread::sleep_for(std::chrono::milliseconds(50));

    auto malformed = std::async(std::launch::async, [port] {
      return run_malformed_client(port);
    });

    std::vector<std::future<reference_client_result>> clients;
    for (int i = 0; i < 7; ++i) {
      clients.push_back(std::async(std::launch::async, [port, i] {
        reference_client_options options;
        options.port = port;
        options.name = "robust-bot-" + std::to_string(i + 1);
        options.seed = static_cast<unsigned int>(3000 + i);
        options.read_timeout_ms = 10000;
        return run_reference_client(options);
      }));
    }

    auto server_results = server_future.get();
    auto malformed_result = malformed.get();
    require(server_results.size() == 2, "malformed test has two match results");

    int forfeit_matches = 0;
    int clean_matches = 0;
    for (const auto& result : server_results) {
      bool saw_gaid = false;
      for (const auto& line : result.match.log) {
        if (line.find("gaid ") != std::string::npos) saw_gaid = true;
      }
      if (saw_gaid) {
        ++forfeit_matches;
      } else {
        ++clean_matches;
        require(result.match.team_a_score >= server_options.game.rules.target_score ||
                    result.match.team_b_score >= server_options.game.rules.target_score,
                "clean concurrent match reached target");
      }
    }
    require(forfeit_matches == 1, "one malformed match forfeited");
    require(clean_matches == 1, "one concurrent match stayed clean");
    require(malformed_result.saw_gaid, "malformed client received GAID");
    require(malformed_result.saw_error, "malformed client received ERROR");
    require(malformed_result.final.team_a_score >= server_options.game.rules.target_score ||
                malformed_result.final.team_b_score >= server_options.game.rules.target_score,
            "malformed client received final standings");

    for (auto& client : clients) {
      auto result = client.get();
      require(result.team_a_score >= server_options.game.rules.target_score ||
                  result.team_b_score >= server_options.game.rules.target_score,
              "healthy client received final standings after malformed peer");
    }
  });

  if (failures != 0) {
    std::cerr << failures << " test failure(s)\n";
    return EXIT_FAILURE;
  }
  std::cerr << "all tests passed\n";
  return EXIT_SUCCESS;
}
