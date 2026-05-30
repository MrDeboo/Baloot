#include "net/network_bot.hpp"

#include "core/gaid.hpp"

#include <utility>

namespace baloot::net {

network_bot::network_bot(int id, std::shared_ptr<tcp_connection> connection,
                         std::string match_id, network_bot_options options)
    : id_(id),
      connection_(std::move(connection)),
      match_id_(std::move(match_id)),
      options_(options) {}

std::vector<action> network_bot::read() {
  try {
    const auto payload =
        connection_->read_frame(options_.read_timeout_ms, options_.max_frame_bytes);
    auto envelope = envelope_from_json(payload);
    if (envelope.match_id != match_id_) {
      throw invalid_action(id_, "client sent actions for the wrong match");
    }
    if (envelope.seq != expected_in_seq_) {
      throw invalid_action(id_, "client action sequence number is out of order");
    }
    ++expected_in_seq_;
    for (const auto& item : envelope.actions) {
      if (item.actor_id != id_) {
        throw invalid_action(id_, "client sent action with mismatched actor_id");
      }
    }
    return envelope.actions;
  } catch (const gaid&) {
    throw;
  } catch (const std::exception& error) {
    throw invalid_action(id_, std::string("network read failed: ") + error.what());
  }
}

void network_bot::write(std::vector<action> actions) {
  try {
    action_envelope envelope;
    envelope.seq = next_out_seq_++;
    envelope.match_id = match_id_;
    envelope.actions = std::move(actions);
    connection_->write_frame(envelope_to_json(envelope));
  } catch (const std::exception& error) {
    throw invalid_action(id_, std::string("network write failed: ") + error.what());
  }
}

int network_bot::id() {
  return id_;
}

void network_bot::send_control(const control_message& message) {
  connection_->write_frame(control_to_json(message));
}

std::shared_ptr<tcp_connection> network_bot::connection() const {
  return connection_;
}

}  // namespace baloot::net
