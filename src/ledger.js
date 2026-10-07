/**
 * 追加式事件账。
 * 同一 event_id 重放且载荷一致时不重复入账（幂等）；
 * event_id 相同而载荷指纹不同时报告冲突，由服务层冻结相关服务包。
 * 指定文件路径后以 JSONL 持久化，进程重启后可重新载入恢复。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { payloadHash } from "./domain.js";

export class EventLedger {
  #events = [];
  #byId = new Map();
  #filePath;

  constructor(filePath = null) {
    this.#filePath = filePath;
    if (filePath && existsSync(filePath)) {
      const lines = readFileSync(filePath, "utf8").split("\n").filter((line) => line.trim());
      for (const line of lines) this.#load(JSON.parse(line));
    }
  }

  #load(entry) {
    const full = { ...entry, hash: entry.hash ?? payloadHash(entry.payload) };
    this.#events.push(full);
    if (!this.#byId.has(full.event_id)) this.#byId.set(full.event_id, full);
  }

  /**
   * 追加事件，返回 { status, event }：
   * applied 入账成功；duplicate 重放忽略；conflict 同号异载荷（未入账）。
   */
  append(event) {
    const { event_id: eventId, type, payload } = event ?? {};
    if (!eventId || !type) throw new Error("事件必须包含 event_id 与 type");
    const hash = payloadHash(payload ?? {});
    const existing = this.#byId.get(eventId);
    if (existing) {
      return existing.hash === hash
        ? { status: "duplicate", event: existing }
        : { status: "conflict", event: existing, received_hash: hash };
    }
    const entry = {
      event_id: String(eventId),
      type: String(type),
      payload: payload ?? {},
      hash,
      recorded_at: event.recorded_at ?? new Date().toISOString(),
    };
    this.#events.push(entry);
    this.#byId.set(entry.event_id, entry);
    if (this.#filePath) {
      mkdirSync(dirname(this.#filePath), { recursive: true });
      appendFileSync(this.#filePath, `${JSON.stringify(entry)}\n`);
    }
    return { status: "applied", event: entry };
  }

  get(eventId) { return this.#byId.get(String(eventId)) ?? null; }
  all() { return [...this.#events]; }
  get size() { return this.#events.length; }
}
