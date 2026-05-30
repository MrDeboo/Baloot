import net from "node:net";
import { EventEmitter } from "node:events";

import { control, encodeFrame, envelope, FrameDecoder, parseMessage } from "./protocol.js";

export class EngineSeatConnection extends EventEmitter {
  constructor({ host = "127.0.0.1", port, name, maxFrameBytes = 64 * 1024 }) {
    super();
    this.host = host;
    this.port = port;
    this.name = name;
    this.maxFrameBytes = maxFrameBytes;
    this.decoder = new FrameDecoder(maxFrameBytes);
    this.socket = null;
    this.selfId = null;
    this.matchId = null;
    this.outSeq = 1;
  }

  async connect(timeoutMs = 5000) {
    this.socket = await this.openSocket(timeoutMs);

    this.socket.on("data", (chunk) => this.handleData(chunk));
    this.socket.on("error", (error) => this.emit("error", error));
    this.socket.on("close", () => this.emit("close"));

    await this.writeControl("HELLO", { name: this.name, version: "1", token: "" });
  }

  openSocket(timeoutMs) {
    const started = Date.now();

    return new Promise((resolve, reject) => {
      const tryConnect = () => {
        const socket = net.createConnection({ host: this.host, port: this.port });
        socket.once("connect", () => resolve(socket));
        socket.once("error", (error) => {
          socket.destroy();
          if (Date.now() - started > timeoutMs) reject(error);
          else setTimeout(tryConnect, 50);
        });
      };
      tryConnect();
    });
  }

  async joinLobby() {
    await this.writeControl("JOIN_LOBBY");
    this.emit("joined_lobby");
  }

  handleData(chunk) {
    try {
      for (const payload of this.decoder.push(chunk)) {
        const message = parseMessage(payload);
        if (message.kind === "MATCH_FOUND") {
          this.selfId = Number(message.self_id);
          this.matchId = message.match_id;
        }
        this.emit("message", message);
      }
    } catch (error) {
      this.emit("error", error);
      this.close();
    }
  }

  writeRaw(payload) {
    if (!this.socket || this.socket.destroyed) {
      throw new Error("engine seat is not connected");
    }
    this.socket.write(encodeFrame(payload));
  }

  async writeControl(kind, fields = {}) {
    this.writeRaw(control(kind, fields));
  }

  sendActions(actions) {
    if (!this.matchId) throw new Error("engine match is not assigned yet");
    this.writeRaw(envelope(this.outSeq++, this.matchId, actions));
  }

  close() {
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
  }
}
