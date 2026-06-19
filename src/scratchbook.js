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

    await this.db.prepare("DELETE FROM scratch WHERE updated_at < ?")
      .bind(Date.now() - SCRATCH_TTL_MS)
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

  async ensureReady() {
    if (!this.db) {
      return false;
    }

    await this.db.prepare(
      "CREATE TABLE IF NOT EXISTS scratch (id TEXT PRIMARY KEY, tail TEXT NOT NULL, updated_at INTEGER NOT NULL)"
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
