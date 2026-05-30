#include "bots/reference_client.hpp"

#include "bots/local_bot.hpp"
#include "core/scoring.hpp"
#include "net/protocol.hpp"

#include <algorithm>
#include <array>
#include <memory>
#include <optional>
#include <stdexcept>
#include <unordered_map>
#include <vector>

namespace baloot {
namespace {

enum class client_phase {
  waiting_for_game,
  waiting_for_middle,
  bidding,
  discussion,
  waiting_for_deal2,
  playing,
  ended,
};

class client_turn_tracker {
 public:
  void set_self(int id) { self_id_ = id; }

  bool observe(const std::vector<action>& actions) {
    bool should_reply = false;
    for (const auto& item : actions) {
      should_reply = observe_one(item) || should_reply;
    }
    return should_reply;
  }

 private:
  int self_id_{};
  client_phase phase_{client_phase::waiting_for_game};
  std::array<int, 4> seats_{};
  bool teams_set_{};
  std::unordered_map<int, team_id> teams_;
  std::optional<card> middle_;
  std::optional<contract> contract_;
  int bidding_phase_{1};
  int bidder_index_{0};
  std::vector<int> discussion_queue_;
  int leader_id_{};
  int next_player_id_{};
  int round_{};
  std::vector<trick_play> current_trick_;

  bool observe_one(const action& item) {
    switch (item.type) {
      case action_type::new_sakkah:
        return false;
      case action_type::new_game:
        seats_ = {std::stoi(item["initiator"]), std::stoi(item["nitwit"]),
                  std::stoi(item["cutter"]), std::stoi(item["dealer"])};
        if (!teams_set_) {
          teams_[seats_[0]] = team_id::a;
          teams_[seats_[2]] = team_id::a;
          teams_[seats_[1]] = team_id::b;
          teams_[seats_[3]] = team_id::b;
          teams_set_ = true;
        }
        middle_.reset();
        contract_.reset();
        current_trick_.clear();
        discussion_queue_.clear();
        bidding_phase_ = 1;
        bidder_index_ = 0;
        leader_id_ = seats_[0];
        next_player_id_ = seats_[0];
        round_ = 0;
        phase_ = client_phase::waiting_for_middle;
        return false;
      case action_type::deal_1:
        return false;
      case action_type::middle_card:
        middle_ = parse_card(item["card"]);
        phase_ = client_phase::bidding;
        bidding_phase_ = 1;
        bidder_index_ = 0;
        return self_id_ == seats_[0];
      case action_type::buy_call:
        return observe_buy_call(item);
      case action_type::deal_2:
        phase_ = client_phase::playing;
        round_ = 1;
        current_trick_.clear();
        leader_id_ = seats_[0];
        next_player_id_ = leader_id_;
        return self_id_ == next_player_id_;
      case action_type::state_project:
      case action_type::show_project:
      case action_type::ikkah:
      case action_type::baloot:
        return false;
      case action_type::play_card:
        return observe_play_card(item);
    }
    return false;
  }

  bool observe_buy_call(const action& item) {
    auto kind = parse_buy_kind(item["call"]);
    if (!kind) return false;
    if ((*kind == buy_kind::enforce_sun || *kind == buy_kind::enforce_hukum) &&
        contract_) {
      if (*kind == buy_kind::enforce_sun) {
        contract_->mode = game_mode::sun;
        contract_->trump.reset();
      } else if (auto trump_text = item.maybe("trump"); trump_text && !trump_text->empty()) {
        contract_->mode = game_mode::hukum;
        contract_->trump = parse_suit(*trump_text);
      }
      phase_ = client_phase::waiting_for_deal2;
      return false;
    }

    if (phase_ == client_phase::bidding) {
      if (*kind == buy_kind::bas) {
        ++bidder_index_;
        if (bidder_index_ == 4) {
          if (bidding_phase_ == 1) {
            bidding_phase_ = 2;
            bidder_index_ = 0;
          } else {
            phase_ = client_phase::waiting_for_game;
            return false;
          }
        }
        return self_id_ == seats_[static_cast<std::size_t>(bidder_index_)];
      }

      set_contract_from_buy(item, *kind);
      phase_ = client_phase::discussion;
      discussion_queue_.clear();
      for (auto it = seats_.rbegin(); it != seats_.rend(); ++it) {
        if (*it != item.actor_id) discussion_queue_.push_back(*it);
      }
      return !discussion_queue_.empty() && discussion_queue_.front() == self_id_;
    }

    if (phase_ == client_phase::discussion) {
      if (*kind == buy_kind::gablak_sun || *kind == buy_kind::gablak_ashkal) {
        set_contract_from_buy(item, *kind);
        discussion_queue_.clear();
        for (auto it = seats_.rbegin(); it != seats_.rend(); ++it) {
          if (*it != item.actor_id) discussion_queue_.push_back(*it);
        }
        return !discussion_queue_.empty() && discussion_queue_.front() == self_id_;
      }
      if ((*kind == buy_kind::bet_open || *kind == buy_kind::bet_close ||
           *kind == buy_kind::bet_double || *kind == buy_kind::bet_triple ||
           *kind == buy_kind::bet_quadruple || *kind == buy_kind::gahwa) &&
          contract_) {
        if (*kind == buy_kind::bet_triple) contract_->multiplier = 3;
        else if (*kind == buy_kind::bet_quadruple) contract_->multiplier = 4;
        else if (*kind != buy_kind::gahwa) contract_->multiplier = 2;
        contract_->gahwa = *kind == buy_kind::gahwa;
        contract_->closed = *kind == buy_kind::bet_close;
      }
      if (*kind == buy_kind::enforce_sun && contract_) {
        contract_->mode = game_mode::sun;
        contract_->trump.reset();
      } else if (*kind == buy_kind::enforce_hukum && contract_) {
        contract_->mode = game_mode::hukum;
        if (auto trump_text = item.maybe("trump"); trump_text && !trump_text->empty()) {
          contract_->trump = parse_suit(*trump_text);
        }
      }
      if (!discussion_queue_.empty() && discussion_queue_.front() == item.actor_id) {
        discussion_queue_.erase(discussion_queue_.begin());
      }
      if (discussion_queue_.empty()) {
        phase_ = client_phase::waiting_for_deal2;
        return contract_ && contract_->mode == game_mode::hukum &&
               contract_->multiplier == 1 && contract_->buyer_id == self_id_;
      }
      return discussion_queue_.front() == self_id_;
    }

    return false;
  }

  void set_contract_from_buy(const action& item, buy_kind kind) {
    contract next;
    next.buyer_id = item.actor_id;
    next.buyer_team = team_of(item.actor_id);
    next.source_call = kind;
    next.taker_id = item.actor_id;
    next.ashkal = kind == buy_kind::ashkal || kind == buy_kind::gablak_ashkal;
    if (kind == buy_kind::hukum) {
      next.mode = game_mode::hukum;
      if (auto trump_text = item.maybe("trump"); trump_text && !trump_text->empty()) {
        next.trump = parse_suit(*trump_text);
      } else if (middle_) {
        next.trump = middle_->s;
      }
    } else {
      next.mode = game_mode::sun;
    }
    contract_ = next;
  }

  bool observe_play_card(const action& item) {
    if (phase_ != client_phase::playing || !contract_) return false;
    auto parsed = parse_card(item["card"]);
    if (!parsed) return false;
    current_trick_.push_back(trick_play{item.actor_id, *parsed});
    if (current_trick_.size() < 4) {
      const auto idx = seat_index(item.actor_id);
      next_player_id_ = seats_[static_cast<std::size_t>((idx + 1) % 4)];
      return self_id_ == next_player_id_;
    }

    const auto winner_index =
        winning_play_index(current_trick_, contract_->mode, contract_->trump);
    leader_id_ = current_trick_[static_cast<std::size_t>(winner_index)].actor_id;
    next_player_id_ = leader_id_;
    current_trick_.clear();
    ++round_;
    if (round_ > 8) {
      phase_ = client_phase::waiting_for_game;
      return false;
    }
    return self_id_ == next_player_id_;
  }

  int seat_index(int player_id) const {
    for (std::size_t i = 0; i < seats_.size(); ++i) {
      if (seats_[i] == player_id) return static_cast<int>(i);
    }
    return 0;
  }

  team_id team_of(int id) const {
    auto it = teams_.find(id);
    if (it != teams_.end()) return it->second;
    return id % 2 == 1 ? team_id::a : team_id::b;
  }
};

int int_field(const net::control_message& message, std::string_view key) {
  auto it = message.fields.find(std::string(key));
  if (it == message.fields.end()) {
    throw net::protocol_error("missing control field: " + std::string(key));
  }
  return std::stoi(it->second);
}

}  // namespace

reference_client_result run_reference_client(reference_client_options options) {
  auto connection = net::connect_tcp(options.host, options.port, options.read_timeout_ms);

  net::control_message hello;
  hello.kind = "HELLO";
  hello.fields = {{"name", options.name}, {"version", "1"}, {"token", ""}};
  connection.write_frame(net::control_to_json(hello));

  auto welcome_payload =
      connection.read_frame(options.read_timeout_ms, options.max_frame_bytes);
  auto welcome = net::control_from_json(welcome_payload);
  if (welcome.kind != "WELCOME") {
    throw net::protocol_error("server did not send WELCOME");
  }

  net::control_message join;
  join.kind = "JOIN_LOBBY";
  connection.write_frame(net::control_to_json(join));

  auto found_payload =
      connection.read_frame(options.read_timeout_ms, options.max_frame_bytes);
  auto found = net::control_from_json(found_payload);
  if (found.kind != "MATCH_FOUND") {
    throw net::protocol_error("server did not send MATCH_FOUND");
  }
  const int self_id = int_field(found, "self_id");
  const auto match_id = found.fields.at("match_id");

  local_bot bot(self_id, options.seed == 0 ? static_cast<unsigned int>(self_id * 1777)
                                           : options.seed);
  client_turn_tracker tracker;
  tracker.set_self(self_id);
  std::uint64_t out_seq = 1;

  while (true) {
    const auto payload =
        connection.read_frame(options.read_timeout_ms, options.max_frame_bytes);
    const auto kind = net::message_kind(payload);
    if (kind == "ACTIONS") {
      auto envelope = net::envelope_from_json(payload);
      if (envelope.match_id != match_id) {
        throw net::protocol_error("server sent wrong match id");
      }
      bot.write(envelope.actions);
      if (tracker.observe(envelope.actions)) {
        net::action_envelope response;
        response.seq = out_seq++;
        response.match_id = match_id;
        response.actions = bot.read();
        connection.write_frame(net::envelope_to_json(response));
      }
      continue;
    }

    auto control = net::control_from_json(payload);
    if (control.kind == "PING") {
      net::control_message pong;
      pong.kind = "PONG";
      if (auto nonce = control.fields.find("nonce"); nonce != control.fields.end()) {
        pong.fields.emplace("nonce", nonce->second);
      }
      connection.write_frame(net::control_to_json(pong));
      continue;
    }
    if (control.kind == "MATCH_END") {
      reference_client_result result;
      result.self_id = self_id;
      result.team_a_score = int_field(control, "team_a_score");
      result.team_b_score = int_field(control, "team_b_score");
      auto winner = parse_team_id(control.fields.at("winner_team"));
      if (winner) result.winner = *winner;
      return result;
    }
    if (control.kind == "ERROR") {
      continue;
    }
  }
}

}  // namespace baloot
