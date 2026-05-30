#include "core/host.hpp"

#include "core/gaid.hpp"

#include <algorithm>
#include <chrono>
#include <sstream>
#include <stdexcept>

namespace baloot {
namespace {

constexpr int host_actor_id = 0;

std::string id_list(const std::array<int, 4>& seats) {
  std::ostringstream out;
  out << seats[0] << "," << seats[1] << "," << seats[2] << "," << seats[3];
  return out.str();
}

std::string points_text(int a, int b) {
  std::ostringstream out;
  out << "A=" << a << " B=" << b;
  return out.str();
}

std::string suit_text(std::optional<suit> value) {
  return value ? to_string(*value) : "";
}

}  // namespace

host::host(std::vector<std::shared_ptr<bot_base>> players, host_options options)
    : players_(std::move(players)), options_(options), rng_(options.seed) {
  if (players_.size() != 4) {
    throw std::invalid_argument("Baloot host requires exactly four players");
  }
  for (std::size_t i = 0; i < players_.size(); ++i) {
    const auto id = players_[i]->id();
    if (by_id_.contains(id)) {
      throw std::invalid_argument("duplicate player id");
    }
    by_id_.emplace(id, players_[i]);
    seats_[i] = id;
  }
  fixed_teams_[seats_[0]] = team_id::a;
  fixed_teams_[seats_[2]] = team_id::a;
  fixed_teams_[seats_[1]] = team_id::b;
  fixed_teams_[seats_[3]] = team_id::b;
}

sakkah_result host::run_sakkah() {
  log_.clear();
  int team_a_score = 0;
  int team_b_score = 0;
  int game_number = 0;

  for (const auto& player_ptr : players_) {
    write_to(player_ptr->id(),
             {make_action(host_actor_id, action_type::new_sakkah,
                          {{"self_id", std::to_string(player_ptr->id())}})});
  }

  while (team_a_score < options_.rules.target_score &&
         team_b_score < options_.rules.target_score) {
    ++game_number;
    try {
      auto result = play_game(game_number, team_a_score, team_b_score);
      team_a_score += result.team_a_points;
      team_b_score += result.team_b_points;
      log("game " + std::to_string(game_number) + " score " +
          points_text(result.team_a_points, result.team_b_points) + " total " +
          points_text(team_a_score, team_b_score));
    } catch (const gaid& error) {
      const auto bad_team = team_of(error.source_id());
      const auto winner = bad_team == team_id::a ? team_id::b : team_id::a;
      if (winner == team_id::a) {
        team_a_score = options_.rules.target_score;
      } else {
        team_b_score = options_.rules.target_score;
      }
      log("gaid " + error.type() + " by player " +
          std::to_string(error.source_id()) + ": " + error.what());
    }
    rotate_seats();
  }

  auto winner = team_a_score >= team_b_score ? team_id::a : team_id::b;
  if (team_a_score == team_b_score) {
    while (team_a_score == team_b_score) {
      ++game_number;
      auto result = play_game(game_number, team_a_score, team_b_score);
      team_a_score += result.team_a_points;
      team_b_score += result.team_b_points;
      rotate_seats();
    }
    winner = team_a_score > team_b_score ? team_id::a : team_id::b;
  }

  return sakkah_result{team_a_score, team_b_score, game_number, winner, log_};
}

std::shared_ptr<bot_base> host::player(int id) const {
  auto it = by_id_.find(id);
  if (it == by_id_.end()) throw std::runtime_error("unknown player id");
  return it->second;
}

team_id host::team_of(int id) const {
  auto it = fixed_teams_.find(id);
  if (it == fixed_teams_.end()) throw std::runtime_error("unknown player team");
  return it->second;
}

int host::partner_of(int id) const {
  const auto team = team_of(id);
  for (const auto& [other_id, other_team] : fixed_teams_) {
    if (other_id != id && other_team == team) return other_id;
  }
  throw std::runtime_error("missing partner");
}

std::string host::score_for(int receiver_id, int team_a, int team_b, bool our) const {
  const auto team = team_of(receiver_id);
  if (our) return std::to_string(team == team_id::a ? team_a : team_b);
  return std::to_string(team == team_id::a ? team_b : team_a);
}

void host::log(std::string message) {
  log_.push_back(std::move(message));
}

void host::write_to(int id, std::vector<action> actions) {
  player(id)->write(std::move(actions));
}

void host::broadcast(std::vector<action> actions) {
  for (const auto& player_ptr : players_) {
    player_ptr->write(actions);
  }
}

void host::rotate_seats() {
  seats_ = {seats_[1], seats_[2], seats_[3], seats_[0]};
}

game_result host::play_game(int game_number, int team_a_score, int team_b_score) {
  for (const auto& player_ptr : players_) {
    const auto id = player_ptr->id();
    write_to(id, {make_action(host_actor_id, action_type::new_game,
                              {{"game", std::to_string(game_number)},
                               {"initiator", std::to_string(seats_[0])},
                               {"nitwit", std::to_string(seats_[1])},
                               {"cutter", std::to_string(seats_[2])},
                               {"dealer", std::to_string(seats_[3])},
                               {"our_score", score_for(id, team_a_score, team_b_score, true)},
                               {"their_score", score_for(id, team_a_score, team_b_score, false)}})});
  }
  log("new game " + std::to_string(game_number) + " seats " + id_list(seats_));

  auto deck = make_deck_32();
  deck.shuffle(rng_);
  std::unordered_map<int, cards> hands;
  for (const auto id : seats_) {
    auto dealt = deck.deal(5);
    hands[id] = dealt;
    write_to(id, {make_action(host_actor_id, action_type::deal_1,
                              {{"cards", dealt.to_string()}})});
  }

  const auto middle = deck.deal(1).at(0);
  broadcast({make_action(host_actor_id, action_type::middle_card,
                         {{"card", to_string(middle)}})});
  log("middle card " + to_string(middle));

  auto contract_value = run_bidding(middle);
  if (!contract_value) {
    log("void game after two pass phases");
    return game_result{};
  }
  run_discussion(*contract_value);

  for (const auto id : seats_) {
    cards extra;
    if (id == contract_value->taker_id) {
      hands[id].append(middle);
      extra.append(middle);
      auto dealt = deck.deal(2);
      hands[id].append(dealt);
      extra.append(dealt);
    } else {
      auto dealt = deck.deal(3);
      hands[id].append(dealt);
      extra.append(dealt);
    }
    write_to(id, {make_action(host_actor_id, action_type::deal_2,
                              {{"cards", extra.to_string()}})});
  }

  std::vector<project> declared_projects;
  std::unordered_map<int, bool> project_window_closed;
  int team_a_bonus = 0;
  int team_b_bonus = 0;
  int team_a_card_points = 0;
  int team_b_card_points = 0;
  int leader = seats_[0];
  std::vector<round> rounds;
  std::unordered_map<int, bool> baloot_half_seen;

  for (int round_index = 0; round_index < 8; ++round_index) {
    if (round_index == 1 && !declared_projects.empty()) {
      const auto winning = winning_projects(declared_projects,
                                            std::vector<int>(seats_.begin(), seats_.end()),
                                            [&](int id) { return team_of(id); });
      for (const auto& item : winning) {
        const auto team = team_of(item.owner_id);
        if (team == team_id::a) team_a_bonus += item.score;
        if (team == team_id::b) team_b_bonus += item.score;
        broadcast({make_action(item.owner_id, action_type::show_project,
                               {{"project", to_string(item.kind)},
                                {"cards", item.project_cards.to_string()},
                                {"score", std::to_string(item.score)}})});
      }
    }

    round current;
    current.leader_id = leader;
    auto leader_it = std::ranges::find(seats_, leader);
    auto start = static_cast<int>(std::distance(seats_.begin(), leader_it));

    for (int offset = 0; offset < 4; ++offset) {
      const auto actor_id = seats_[static_cast<std::size_t>((start + offset) % 4)];
      const auto actions = player(actor_id)->read();
      std::optional<card> played;
      bool ikkah = false;
      bool baloot = false;

      for (const auto& item : actions) {
        if (item.actor_id != actor_id) {
          throw invalid_action(actor_id, "action actor does not match active player");
        }
        if (item.type == action_type::state_project) {
          if (project_window_closed[actor_id]) {
            throw invalid_action(actor_id, "projects must be declared before first play");
          }
          const auto kind = parse_project_kind(item["project"]);
          if (!kind) throw invalid_action(actor_id, "unknown project kind");
          auto declared = parse_cards(item["cards"]);
          declared_projects.push_back(
              validate_project(actor_id, hands[actor_id], *kind, declared,
                               contract_value->mode));
          broadcast({item});
        } else if (item.type == action_type::ikkah) {
          ikkah = true;
          broadcast({item});
        } else if (item.type == action_type::baloot) {
          baloot = true;
          broadcast({item});
        } else if (item.type == action_type::play_card) {
          auto parsed = parse_card(item["card"]);
          if (!parsed) throw invalid_action(actor_id, "invalid played card");
          if (played) throw invalid_action(actor_id, "multiple PLAY_CARD actions");
          played = *parsed;
        } else {
          throw invalid_action(actor_id, "unexpected action during play");
        }
      }

      if (!played) throw invalid_action(actor_id, "missing PLAY_CARD action");
      if (baloot) {
        const auto is_baloot_card =
            contract_value->mode == game_mode::hukum && contract_value->trump &&
            played->s == *contract_value->trump &&
            (played->r == rank::king || played->r == rank::queen);
        if (!is_baloot_card || !baloot_half_seen[actor_id]) {
          throw invalid_action(actor_id,
                               "BALOOT must be declared on the second trump K/Q");
        }
        const auto team = team_of(actor_id);
        if (team == team_id::a) team_a_bonus += options_.rules.baloot_bonus;
        if (team == team_id::b) team_b_bonus += options_.rules.baloot_bonus;
      }
      if (ikkah) {
        if (contract_value->mode != game_mode::hukum || !contract_value->trump ||
            !current.plays.empty() || played->s == *contract_value->trump) {
          throw invalid_action(actor_id,
                               "IKKAH requires a HUKUM trick lead with non-trump");
        }
        for (const auto& [other_id, other_hand] : hands) {
          for (const auto value : other_hand.values()) {
            if (other_id == actor_id && value == *played) continue;
            if (value.s == played->s &&
                card_strength(value, game_mode::sun, std::nullopt) >
                    card_strength(*played, game_mode::sun, std::nullopt)) {
              throw invalid_action(actor_id,
                                   "IKKAH requires leading the highest remaining suit card");
            }
          }
        }
      }

      trick_context context;
      context.mode = contract_value->mode;
      context.trump = contract_value->trump;
      context.closed = contract_value->closed;
      context.player_id = actor_id;
      context.team_of = [&](int id) { return team_of(id); };
      context.plays = current.plays;
      validate_play_or_throw(hands[actor_id], *played, context);
      if (contract_value->mode == game_mode::hukum && contract_value->trump &&
          played->s == *contract_value->trump &&
          (played->r == rank::king || played->r == rank::queen)) {
        baloot_half_seen[actor_id] = true;
      }
      hands[actor_id].remove(*played);
      project_window_closed[actor_id] = true;
      current.plays.push_back(trick_play{actor_id, *played, ikkah, baloot});
      broadcast({make_action(actor_id, action_type::play_card,
                             {{"card", to_string(*played)},
                              {"round", std::to_string(round_index + 1)}})});
      log("round " + std::to_string(round_index + 1) + " player " +
          std::to_string(actor_id) + " played " + to_string(*played));
    }

    const auto winner_index =
        winning_play_index(current.plays, contract_value->mode, contract_value->trump);
    current.winner_id = current.plays[static_cast<std::size_t>(winner_index)].actor_id;
    current.points =
        trick_points(current.plays, contract_value->mode, contract_value->trump);
    if (round_index == 7) current.points += options_.rules.last_trick_bonus;

    if (team_of(current.winner_id) == team_id::a) {
      team_a_card_points += current.points;
    } else {
      team_b_card_points += current.points;
    }
    leader = current.winner_id;
    rounds.push_back(current);
    log("round " + std::to_string(round_index + 1) + " winner " +
        std::to_string(current.winner_id) + " points " +
        std::to_string(current.points));
  }

  return score_completed_game(*contract_value, team_a_card_points, team_b_card_points,
                              team_a_bonus, team_b_bonus, options_.rules);
}

std::optional<contract> host::run_bidding(const card& middle) {
  for (int phase = 1; phase <= 2; ++phase) {
    for (const auto actor_id : seats_) {
      auto call = read_buy_call(actor_id, phase);
      broadcast({make_action(actor_id, action_type::buy_call,
                             {{"call", to_string(call.kind)},
                              {"phase", std::to_string(phase)},
                              {"trump", suit_text(call.trump)}})});
      if (call.kind == buy_kind::bas) continue;

      if (call.kind == buy_kind::ashkal &&
          actor_id != seats_[2] && actor_id != seats_[3]) {
        throw invalid_action(actor_id, "ASHKAL is only legal for cutter or dealer");
      }
      if (phase == 2 && call.kind == buy_kind::ashkal) {
        throw invalid_action(actor_id, "ASHKAL is not legal in phase 2");
      }

      contract out;
      out.buyer_id = actor_id;
      out.buyer_team = team_of(actor_id);
      out.source_call = call.kind;
      out.ashkal = call.kind == buy_kind::ashkal;
      out.taker_id = out.ashkal ? partner_of(actor_id) : actor_id;

      if (call.kind == buy_kind::hukum) {
        out.mode = game_mode::hukum;
        out.trump = phase == 1 ? middle.s : call.trump;
        if (!out.trump) {
          throw invalid_action(actor_id, "phase 2 HUKUM must name trump");
        }
        if (phase == 2 && *out.trump == middle.s) {
          throw invalid_action(actor_id, "phase 2 HUKUM cannot use middle suit");
        }
      } else if (call.kind == buy_kind::sun || call.kind == buy_kind::ashkal) {
        out.mode = game_mode::sun;
      } else {
        throw invalid_action(actor_id, "unexpected buy call");
      }
      log("player " + std::to_string(actor_id) + " bought " +
          to_string(out.source_call));
      return out;
    }
  }
  return std::nullopt;
}

void host::run_discussion(contract& contract_value) {
  int transitions = 0;
  bool restart = false;
  std::optional<team_id> last_raiser_team;
  auto bet_value = [](buy_kind kind, int current) {
    switch (kind) {
      case buy_kind::bet_open:
      case buy_kind::bet_close:
      case buy_kind::bet_double:
        return std::max(current, 2);
      case buy_kind::bet_triple:
        return std::max(current, 3);
      case buy_kind::bet_quadruple:
        return std::max(current, 4);
      case buy_kind::gahwa:
        return current;
      default:
        return current;
    }
  };

  do {
    restart = false;
    for (auto it = seats_.rbegin(); it != seats_.rend(); ++it) {
      const auto actor_id = *it;
      if (actor_id == contract_value.buyer_id) continue;
      auto call = read_buy_call(actor_id, 0);

      broadcast({make_action(actor_id, action_type::buy_call,
                             {{"call", to_string(call.kind)},
                              {"phase", "discussion"},
                              {"trump", suit_text(call.trump)}})});

      if (call.kind == buy_kind::bas) continue;

      if (call.kind == buy_kind::gablak_sun ||
          call.kind == buy_kind::gablak_ashkal) {
        if (call.kind == buy_kind::gablak_ashkal &&
            actor_id != seats_[2] && actor_id != seats_[3]) {
          throw invalid_action(actor_id,
                               "GABLAK_ASHKAL is only legal for cutter or dealer");
        }
        if (team_of(actor_id) == contract_value.buyer_team &&
            contract_value.source_call != buy_kind::hukum) {
          throw invalid_action(actor_id,
                               "cannot gablak teammate unless original buy was HUKUM");
        }

        contract_value.mode = game_mode::sun;
        contract_value.trump.reset();
        contract_value.buyer_id = actor_id;
        contract_value.buyer_team = team_of(actor_id);
        contract_value.source_call = call.kind;
        contract_value.multiplier = 1;
        contract_value.closed = false;
        contract_value.gahwa = false;
        contract_value.ashkal = call.kind == buy_kind::gablak_ashkal;
        contract_value.taker_id =
            contract_value.ashkal ? partner_of(actor_id) : actor_id;
        last_raiser_team.reset();
        restart = true;
        ++transitions;
        log("player " + std::to_string(actor_id) + " gablak " +
            to_string(call.kind));
        if (transitions > 16) {
          throw invalid_action(actor_id, "too many recursive gablak transitions");
        }
        break;
      }

      if (call.kind == buy_kind::bet_open || call.kind == buy_kind::bet_close ||
          call.kind == buy_kind::bet_double || call.kind == buy_kind::bet_triple ||
          call.kind == buy_kind::bet_quadruple || call.kind == buy_kind::gahwa) {
        const auto actor_team = team_of(actor_id);
        if (!last_raiser_team && actor_team == contract_value.buyer_team) {
          throw invalid_action(actor_id, "buyer team cannot open the bet");
        }
        if (contract_value.mode == game_mode::sun && call.kind == buy_kind::bet_close) {
          throw invalid_action(actor_id, "Sun betting can only be open");
        }
        if (last_raiser_team && actor_team == *last_raiser_team) {
          throw invalid_action(actor_id, "betting must alternate between teams");
        }
        const auto next_multiplier = bet_value(call.kind, contract_value.multiplier);
        if (next_multiplier < contract_value.multiplier) {
          throw invalid_action(actor_id, "bet multiplier cannot decrease");
        }
        contract_value.multiplier = next_multiplier;
        contract_value.closed = call.kind == buy_kind::bet_close;
        contract_value.gahwa = call.kind == buy_kind::gahwa;
        last_raiser_team = actor_team;
        log("player " + std::to_string(actor_id) + " bet " +
            to_string(call.kind));
        continue;
      }

      throw invalid_action(actor_id, "unexpected discussion call");
    }
  } while (restart);

  if (contract_value.mode == game_mode::hukum && contract_value.multiplier == 1) {
    auto call = read_buy_call(contract_value.buyer_id, 0);
    broadcast({make_action(contract_value.buyer_id, action_type::buy_call,
                           {{"call", to_string(call.kind)},
                            {"phase", "enforce"},
                            {"trump", suit_text(call.trump)}})});

    if (call.kind == buy_kind::enforce_sun) {
      contract_value.mode = game_mode::sun;
      contract_value.trump.reset();
      log("player " + std::to_string(contract_value.buyer_id) +
          " enforced HUKUM to SUN");
      run_discussion(contract_value);
    } else if (call.kind == buy_kind::enforce_hukum) {
      if (call.trump) contract_value.trump = call.trump;
    } else if (call.kind != buy_kind::bas) {
      throw invalid_action(contract_value.buyer_id,
                           "expected ENFORCE_SUN, ENFORCE_HUKUM, or BAS");
    }
  }
}

buy_call host::read_buy_call(int actor_id, int phase) {
  auto actions = player(actor_id)->read();
  if (actions.size() != 1 || actions.front().type != action_type::buy_call) {
    throw invalid_action(actor_id, "expected exactly one BUY_CALL action");
  }
  const auto& item = actions.front();
  if (item.actor_id != actor_id) {
    throw invalid_action(actor_id, "BUY_CALL actor does not match active player");
  }
  auto kind = parse_buy_kind(item["call"]);
  if (!kind) throw invalid_action(actor_id, "unknown BUY_CALL value");
  std::optional<suit> trump;
  if (auto trump_text = item.maybe("trump"); trump_text && !trump_text->empty()) {
    trump = parse_suit(*trump_text);
    if (!trump) throw invalid_action(actor_id, "invalid trump suit");
  }
  return buy_call{actor_id, *kind, phase, trump};
}

action host::read_single_action(int actor_id, action_type expected) {
  auto actions = player(actor_id)->read();
  if (actions.size() != 1 || actions.front().type != expected) {
    throw invalid_action(actor_id, "unexpected action");
  }
  return actions.front();
}

}  // namespace baloot
