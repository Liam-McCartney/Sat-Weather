import { SCRATCH_TTL_MS } from "./config.js";

export class ScratchBook {
  constructor(env) {
    this.db = env?.SCRATCH;
    this.secret = String(env?.SCRATCH_SECRET || "sat-weather-scratch").trim();
  }

  async purgeOld() {
    if (!await this.ensureReady()) {
      return;
    }

    const cutoff = Date.now() - SCRATCH_TTL_MS;
    await this.db.prepare("DELETE FROM scratch WHERE updated_at < ?")
      .bind(cutoff)
      .run();
    await this.db.prepare("DELETE FROM last_reply WHERE updated_at < ?")
      .bind(cutoff)
      .run();
  }

  async save(from, tail) {
    const id = await this.senderId(from);
    if (!id || !await this.ensureReady()) {
      return false;
    }

    await this.db.prepare(
      "INSERT INTO scratch (id, tail, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET tail = excluded.tail, updated_at = excluded.updated_at"
    ).bind(id, tail, Date.now()).run();
    return true;
  }

  async get(from) {
    const id = await this.senderId(from);
    if (!id || !await this.ensureReady()) {
      return "";
    }

    const row = await this.db.prepare("SELECT tail FROM scratch WHERE id = ?")
      .bind(id)
      .first();
    return String(row?.tail || "").trim();
  }

  async delete(from) {
    const id = await this.senderId(from);
    if (!id || !await this.ensureReady()) {
      return;
    }

    await this.db.prepare("DELETE FROM scratch WHERE id = ?")
      .bind(id)
      .run();
  }

  async saveLastReply(from, reply) {
    const id = await this.senderId(from);
    const text = String(reply || "").trim();
    if (!id || !text || !await this.ensureReady()) {
      return false;
    }

    await this.db.prepare(
      "INSERT INTO last_reply (id, reply, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET reply = excluded.reply, updated_at = excluded.updated_at"
    ).bind(id, text, Date.now()).run();
    return true;
  }

  async getLastReply(from) {
    const id = await this.senderId(from);
    if (!id || !await this.ensureReady()) {
      return "";
    }

    const row = await this.db.prepare("SELECT reply FROM last_reply WHERE id = ?")
      .bind(id)
      .first();
    return String(row?.reply || "").trim();
  }

  async ensureReady() {
    if (!this.db) {
      return false;
    }

    await this.db.prepare(
      "CREATE TABLE IF NOT EXISTS scratch (id TEXT PRIMARY KEY, tail TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    ).run();
    await this.db.prepare(
      "CREATE TABLE IF NOT EXISTS last_reply (id TEXT PRIMARY KEY, reply TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    ).run();
    return true;
  }

  async senderId(from) {
    const sender = String(from || "").trim();
    if (!sender) {
      return "";
    }

    const bytes = new TextEncoder().encode(`${this.secret}:${sender}`);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
}
