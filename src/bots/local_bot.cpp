#include "bots/local_bot.hpp"

#include "core/scoring.hpp"

#include <algorithm>
#include <cstdlib>
#include <stdexcept>

namespace baloot {

local_bot::local_bot(int id, unsigned int seed)
    : id_(id), rng_(seed == 0 ? static_cast<unsigned int>(id * 7919 + 17) : seed) {}

std::vector<action> local_bot::read() {
  if (!in_play_) {
    if (!contract_ && middle_ && should_buy()) {
      bought_this_game_ = true;
      return {make_action(id_, action_type::buy_call, {{"call", "SUN"}})};
    }
    return {make_action(id_, action_type::buy_call, {{"call", "BAS"}})};
  }
  return play_actions();
}

void local_bot::write(std::vector<action> actions) {
  for (const auto& item : actions) {
    switch (item.type) {
      case action_type::new_sakkah:
        break;
      case action_type::new_game: {
        hand_ = cards{};
        middle_ = std::nullopt;
        contract_ = std::nullopt;
        current_trick_.clear();
        projects_declared_ = false;
        bought_this_game_ = false;
        in_play_ = false;
        seats_ = {std::stoi(item["initiator"]), std::stoi(item["nitwit"]),
                  std::stoi(item["cutter"]), std::stoi(item["dealer"])};
        if (!teams_set_) {
          teams_[seats_[0]] = team_id::a;
          teams_[seats_[2]] = team_id::a;
          teams_[seats_[1]] = team_id::b;
          teams_[seats_[3]] = team_id::b;
          teams_set_ = true;
        }
        break;
      }
      case action_type::deal_1:
      case action_type::deal_2:
        hand_.append(parse_cards(item["cards"]));
        if (item.type == action_type::deal_2) in_play_ = true;
        break;
      case action_type::middle_card:
        middle_ = parse_card(item["card"]);
        break;
      case action_type::buy_call: {
        auto kind = parse_buy_kind(item["call"]);
        if (!kind) break;
        if (*kind == buy_kind::sun || *kind == buy_kind::ashkal ||
            *kind == buy_kind::gablak_sun || *kind == buy_kind::gablak_ashkal) {
          contract next;
          next.mode = game_mode::sun;
          next.buyer_id = item.actor_id;
          next.buyer_team = team_of(item.actor_id);
          next.taker_id = item.actor_id;
          next.source_call = *kind;
          next.ashkal = *kind == buy_kind::ashkal || *kind == buy_kind::gablak_ashkal;
          contract_ = next;
        } else if (*kind == buy_kind::hukum) {
          contract next;
          next.mode = game_mode::hukum;
          next.buyer_id = item.actor_id;
          next.buyer_team = team_of(item.actor_id);
          next.taker_id = item.actor_id;
          next.source_call = *kind;
          if (auto trump_text = item.maybe("trump"); trump_text && !trump_text->empty()) {
            next.trump = parse_suit(*trump_text);
          } else if (middle_) {
            next.trump = middle_->s;
          }
          contract_ = next;
        } else if (*kind == buy_kind::enforce_sun && contract_) {
          contract_->mode = game_mode::sun;
          contract_->trump.reset();
        } else if (*kind == buy_kind::enforce_hukum && contract_) {
          contract_->mode = game_mode::hukum;
          if (auto trump_text = item.maybe("trump"); trump_text && !trump_text->empty()) {
            contract_->trump = parse_suit(*trump_text);
          }
        } else if ((*kind == buy_kind::bet_open || *kind == buy_kind::bet_close ||
                    *kind == buy_kind::bet_double || *kind == buy_kind::bet_triple ||
                    *kind == buy_kind::bet_quadruple || *kind == buy_kind::gahwa) &&
                   contract_) {
          if (*kind == buy_kind::bet_triple) contract_->multiplier = 3;
          else if (*kind == buy_kind::bet_quadruple) contract_->multiplier = 4;
          else if (*kind != buy_kind::gahwa) contract_->multiplier = 2;
          contract_->gahwa = *kind == buy_kind::gahwa;
          contract_->closed = *kind == buy_kind::bet_close;
        }
        break;
      }
      case action_type::play_card: {
        auto parsed = parse_card(item["card"]);
        if (parsed) {
          if (item.actor_id == id_) hand_.remove(*parsed);
          current_trick_.push_back(trick_play{item.actor_id, *parsed});
          if (current_trick_.size() == 4) current_trick_.clear();
        }
        break;
      }
      case action_type::state_project:
      case action_type::show_project:
      case action_type::ikkah:
      case action_type::baloot:
        break;
    }
  }
}

int local_bot::id() {
  return id_;
}

team_id local_bot::team_of(int id) const {
  auto it = teams_.find(id);
  if (it == teams_.end()) return id % 2 == 1 ? team_id::a : team_id::b;
  return it->second;
}

bool local_bot::should_buy() const {
  if (bought_this_game_) return false;
  return id_ == 1;
}

std::vector<action> local_bot::play_actions() {
  std::vector<action> actions;
  if (!projects_declared_ && contract_) {
    auto projects = find_projects(id_, hand_, contract_->mode);
    if (!projects.empty()) {
      const auto& best = projects.front();
      actions.push_back(make_action(id_, action_type::state_project,
                                    {{"project", to_string(best.kind)},
                                     {"cards", best.project_cards.to_string()}}));
    }
    projects_declared_ = true;
  }

  trick_context context;
  context.mode = contract_->mode;
  context.trump = contract_->trump;
  context.closed = contract_->closed;
  context.player_id = id_;
  context.team_of = [&](int player_id) { return team_of(player_id); };
  context.plays = current_trick_;

  auto legal = legal_cards(hand_, context);
  if (legal.empty()) throw std::runtime_error("local bot has no legal card");
  std::uniform_int_distribution<std::size_t> pick(0, legal.size() - 1);
  const auto played = legal.at(pick(rng_));
  actions.push_back(make_action(id_, action_type::play_card,
                                {{"card", to_string(played)}}));
  return actions;
}

}  // namespace baloot
