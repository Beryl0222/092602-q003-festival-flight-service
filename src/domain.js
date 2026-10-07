/** 基础领域记录及输入校验。 */
import { createHash } from "node:crypto";

export function createRecord(payload) {
  const required = ["record_id", "owner_id", "state"];
  const missing = required.filter((name) => !String(payload[name] ?? "").trim());
  if (missing.length) throw new Error(`缺少必要字段：${missing.join("、")}`);
  const revision = Number(payload.revision ?? 1);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("revision 必须是正整数");
  return Object.freeze({
    record_id: String(payload.record_id), owner_id: String(payload.owner_id),
    state: String(payload.state), revision,
    created_at: payload.created_at || new Date().toISOString(),
  });
}

/* ---------- 节日服务包重排领域规则 ---------- */

/** 权益种类：休息室、节日食品、非遗演示活动。 */
export const ENTITLEMENT_KINDS = ["lounge_access", "festival_food", "heritage_demo"];

/** 权益生命周期：预留 → 确认 → 核销；未兑现可经替代方案回到预留。 */
export const ENTITLEMENT_STATES = ["reserved", "confirmed", "redeemed", "released", "unfulfilled"];

const TRANSITIONS = {
  reserved: ["confirmed", "released", "unfulfilled"],
  confirmed: ["redeemed", "released", "unfulfilled"],
  redeemed: [],
  released: [],
  unfulfilled: ["reserved"],
};

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

/** 仍处于占用份额状态的权益。 */
export const ACTIVE_STATES = ["reserved", "confirmed"];

function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function requireFields(payload, fields) {
  const missing = fields.filter((name) => isBlank(payload?.[name]));
  if (missing.length) throw new Error(`缺少必要字段：${missing.join("、")}`);
}

/** 旅客过敏原与批次声明的交集，非空即冲突。 */
export function allergenConflict(passengerAllergens = [], batchAllergens = []) {
  const declared = new Set(batchAllergens);
  return passengerAllergens.filter((name) => declared.has(name));
}

/** 稳定序列化（键排序），用于载荷指纹。 */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const body = Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",");
    return `{${body}}`;
  }
  return JSON.stringify(value ?? null);
}

export function payloadHash(payload) {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}
