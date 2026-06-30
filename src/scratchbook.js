import { SCRATCH_TTL_MS } from "./config.js";

export class ScratchBook {
  // D1-backed state: scratch pages are temporary, last replies recover failures, profiles persist sender constraints.
  constructor(env) {
    this.db = env?.SCRATCH;
    this.secret = String(env?.SCRATCH_SECRET || "sat-weather-scratch").trim();
  }

  // Opportunistic cleanup runs on normal requests; no scheduled worker needed.
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

  // Scratch tail stores the next page for cont.
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

  // Last full reply lets delivery-failure notices trigger a safer retry.
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

  // Persist once a sender proves it needs short satellite-safe replies.
  async markConstrainedSender(from, profile = "spot") {
    const id = await this.senderId(from);
    if (!id || !await this.ensureReady()) {
      return false;
    }

    await this.db.prepare(
      "INSERT INTO sender_profile (id, profile, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at"
    ).bind(id, profile, Date.now()).run();
    return true;
  }

  // Sender profile is persistent, unlike scratch pages, so one failure teaches future replies.
  async isConstrainedSender(from) {
    const id = await this.senderId(from);
    if (!id || !await this.ensureReady()) {
      return false;
    }

    const row = await this.db.prepare("SELECT profile FROM sender_profile WHERE id = ?")
      .bind(id)
      .first();
    return ["spot", "sat", "constrained"].includes(String(row?.profile || "").toLowerCase());
  }

  // Lazily create tables so local/manual D1 setup stays minimal.
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
    await this.db.prepare(
      "CREATE TABLE IF NOT EXISTS sender_profile (id TEXT PRIMARY KEY, profile TEXT NOT NULL, updated_at INTEGER NOT NULL)"
    ).run();
    return true;
  }

  // Hash phone numbers before storing them so D1 does not contain raw sender ids.
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
