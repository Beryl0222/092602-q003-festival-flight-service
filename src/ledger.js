/** 事件账：追加式 JSONL 存储，按事件编号幂等，编号相同而载荷不同视为冲突。 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** 稳定序列化，保证同一载荷得到同一摘要。 */
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function hashPayload(payload) {
  return createHash("sha256").update(canonicalize(payload)).digest("hex");
}

export class EventLedger {
  #events = [];
  #byId = new Map();

  /** filePath 为空时为纯内存账；否则从文件恢复并向文件追加。 */
  constructor(filePath = null) {
    this.filePath = filePath;
    if (filePath && existsSync(filePath)) {
      for (const line of readFileSync(filePath, "utf8").split("\n")) {
        if (line.trim()) this.#register(JSON.parse(line));
      }
    }
  }

  #register(record) {
    this.#events.push(record);
    this.#byId.set(record.event_id, record);
  }

  get size() { return this.#events.length; }
  all() { return [...this.#events]; }
  find(eventId) { return this.#byId.get(eventId) ?? null; }

  /**
   * 追加事件。返回：
   * - applied   新事件已入账；
   * - duplicate 编号与载荷摘要均相同，重放不产生新事实；
   * - conflict  编号相同但载荷摘要不同，入账被拒绝。
   */
  append(event) {
    if (!event?.event_id || !event?.type) throw new Error("事件缺少 event_id 或 type");
    const payloadHash = hashPayload(event.payload ?? null);
    const seen = this.#byId.get(event.event_id);
    if (seen) {
      return seen.payload_hash === payloadHash
        ? { status: "duplicate", event: seen }
        : { status: "conflict", event: seen, incoming: event };
    }
    const record = { ...event, payload_hash: payloadHash, seq: this.#events.length + 1 };
    if (this.filePath) {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
    }
    this.#register(record);
    return { status: "applied", event: record };
  }
}
