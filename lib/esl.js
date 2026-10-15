const net = require("node:net");
const { EventEmitter } = require("node:events");

// ESL frames are byte-counted, not line-counted. Events and command replies may
// arrive together or split across TCP packets (including inside UTF-8 text).
class FrameParser {
  constructor(onFrame) { this.buffer = Buffer.alloc(0); this.onFrame = onFrame; }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const end = this.buffer.indexOf("\n\n");
      if (end < 0) return;
      const headers = {};
      for (const line of this.buffer.subarray(0, end).toString().split("\n")) {
        const colon = line.indexOf(":");
        if (colon >= 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
      }
      const length = Number(headers["content-length"] || 0);
      if (!Number.isSafeInteger(length) || length < 0 || length > 8_000_000) throw new Error("Invalid ESL frame length");
      if (this.buffer.length < end + 2 + length) return;
      const body = this.buffer.subarray(end + 2, end + 2 + length).toString();
      this.buffer = this.buffer.subarray(end + 2 + length);
      this.onFrame({ headers, body });
    }
  }
}

class EslClient extends EventEmitter {
  constructor({ host = "127.0.0.1", port = 8021, password, timeout = 5000 }) {
    super();
    Object.assign(this, { host, port, password, timeout });
    this.ready = false;
    this.pending = [];
  }
  connect() {
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    if (!this.password || /[\r\n]/.test(this.password)) return Promise.reject(new Error("请设置有效的 FREESWITCH_ESL_PASSWORD"));
    this.connecting = new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      const timer = setTimeout(() => socket.destroy(new Error("FreeSWITCH ESL 连接超时")), this.timeout);
      let authenticating = false;
      const parser = new FrameParser(frame => {
        const type = frame.headers["content-type"];
        if (type === "auth/request" && !authenticating) {
          authenticating = true;
          this.command(`auth ${this.password}`).then(reply => {
            if (!reply.startsWith("+OK")) throw new Error("FreeSWITCH ESL 认证失败");
            return this.command("event json CHANNEL_CREATE CHANNEL_PROGRESS CHANNEL_PROGRESS_MEDIA CHANNEL_ANSWER CHANNEL_BRIDGE CHANNEL_HANGUP_COMPLETE BACKGROUND_JOB");
          }).then(reply => {
            if (!reply.startsWith("+OK")) throw new Error("FreeSWITCH 事件订阅失败");
            clearTimeout(timer);
            this.ready = true;
            resolve();
            this.emit("ready");
          }).catch(error => socket.destroy(error));
        } else if (type === "text/event-json") {
          this.emit("event", JSON.parse(frame.body));
        } else if (type === "command/reply" || type === "api/response") {
          const request = this.pending.shift();
          if (request) {
            clearTimeout(request.timer);
            request.resolve(type === "api/response" ? frame.body.trim() : frame.headers["reply-text"] || "");
          }
        } else if (type === "text/disconnect-notice") {
          socket.destroy(new Error("FreeSWITCH 断开 ESL 连接"));
        }
      });
      socket.on("data", chunk => {
        try { parser.push(chunk); } catch (error) { socket.destroy(error); }
      });
      let disconnectError;
      socket.on("error", error => { disconnectError = error; });
      socket.on("close", () => {
        clearTimeout(timer);
        this.ready = false;
        this.connecting = null;
        const error = disconnectError || new Error("FreeSWITCH ESL 连接已关闭");
        for (const request of this.pending.splice(0)) {
          clearTimeout(request.timer);
          request.reject(error);
        }
        reject(error);
        this.emit("disconnected", error);
      });
    });
    return this.connecting;
  }
  command(command) {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error("FreeSWITCH 未连接"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A late response must never be mistaken for the next command's reply.
        this.socket.destroy(new Error("FreeSWITCH ESL 命令超时"));
      }, this.timeout);
      this.pending.push({ resolve, reject, timer });
      this.socket.write(`${command}\n\n`);
    });
  }
  async api(command) {
    if (!this.ready) throw new Error("FreeSWITCH 未连接");
    if (/[\r\n]/.test(command)) throw new Error("Invalid ESL command");
    return this.command(`api ${command}`);
  }
  close() { this.socket?.destroy(); }
}

module.exports = { EslClient, FrameParser };
