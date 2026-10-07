/**
 * 节日航班服务包重排的应用服务入口。
 *
 * 领域行为全部通过事件账驱动：
 * - 每项权益从预留到确认占用唯一可用份额（休息室容量 / 批次数量 / 人员场次）；
 * - 航班拆并时只迁移仍可兑现且符合目的地规则的权益，已核销体验保持原事实；
 * - 同一 event_id 重放幂等不二次占用，同号异载荷冻结相关服务包；
 * - 高风险食品替换需不同角色复核，供应方不能批准自身批次；
 * - 进程重启后从事件账恢复，recover() 续办未完成的迁移与补偿；
 * - passengerStatement() 返回旅客最终可领取项目、每次变更依据、未兑现责任与受影响批次。
 */
import {
  ACTIVE_STATES,
  ENTITLEMENT_KINDS,
  allergenConflict,
  createRecord,
  requireFields,
} from "./domain.js";
import { EventLedger } from "./ledger.js";
import { Repository } from "./repository.js";

const EVENT_TYPES = new Set([
  "passenger_registered", "flight_registered", "station_registered", "batch_registered",
  "batch_recalled", "staff_registered", "staff_cancelled", "destination_rule_registered",
  "loading_recorded", "entitlement_reserved", "entitlement_confirmed", "entitlement_redeemed",
  "entitlement_released", "flights_merged", "flight_split", "entitlement_migrated",
  "obligation_recorded", "compensation_offered", "compensation_fulfilled",
  "substitution_proposed", "substitution_reviewed", "packages_frozen", "freeze_lifted",
]);

const KIND_LABEL = { lounge_access: "休息室", festival_food: "节日食品", heritage_demo: "非遗演示" };

function blankState() {
  return {
    passengers: new Map(),   // passenger_id -> { allergens }
    flights: new Map(),      // flight_id -> { versions: Map, current }
    stations: new Map(),     // station_id -> { airport, capacity }
    batches: new Map(),      // batch_id -> { supplier_id, kind, allergens, high_risk, quantity, recalled }
    staff: new Map(),        // staff_id -> { qualifications, sessions, active }
    rules: new Map(),        // `${airport}:${kind}` -> { allowed, note }
    loadings: new Map(),     // `${flight_id}:${version}:${batch_id}` -> { quantity }
    entitlements: new Map(), // entitlement_id -> 权益投影
    substitutions: new Map(),
    obligations: new Map(),
    compensations: new Map(),
    migrations: new Map(),   // plan_id -> { kind, pending:Set, settled:Map, ... }
    freezes: new Map(),      // entitlement_id -> { freeze_id, reason, conflicting_event_id }
    conflicts: [],
  };
}

export class Service {
  #state = blankState();
  #seq = 0;

  constructor(options = {}) {
    const { repository = new Repository(), ledger = null, ledgerPath = null } = options;
    this.repository = repository;
    this.ledger = ledger ?? new EventLedger(ledgerPath);
    for (const entry of this.ledger.all()) this.#fold(entry);
  }

  /* ---------- 基础登记能力（保留） ---------- */

  health() {
    return { service: "festival_flight_service", status: "ok", events: this.ledger.size };
  }

  register(payload) { return this.repository.add(createRecord(payload)); }

  find(recordId) { return this.repository.get(String(recordId)); }

  /* ---------- 事件入口 ---------- */

  /**
   * 应用一条运行事件。
   * 返回 applied / duplicate / conflict_frozen；业务校验失败抛出中文错误。
   */
  applyEvent(event) {
    if (!event?.event_id || !event?.type) throw new Error("事件必须包含 event_id 与 type");
    if (!EVENT_TYPES.has(event.type)) throw new Error(`未知事件类型：${event.type}`);
    const existing = this.ledger.get(event.event_id);
    if (existing) {
      const replay = this.ledger.append(event);
      if (replay.status === "conflict") return this.#freezeConflict(event, replay);
      return { status: "duplicate", event_id: existing.event_id };
    }
    this.#validate(event);
    const { event: entry } = this.ledger.append(event);
    this.#fold(entry);
    return { status: "applied", event_id: entry.event_id, derived: this.#derive(entry) };
  }

  /** 重启恢复：续办事件账中未完成的迁移，并返回恢复报告。 */
  recover() {
    const resumed = [];
    for (const plan of this.#state.migrations.values()) {
      if (plan.pending.size) {
        this.#settlePlan(plan);
        resumed.push(plan.plan_id);
      }
    }
    return { resumed_plans: resumed, report: this.recoveryReport() };
  }

  recoveryReport() {
    const s = this.#state;
    return {
      pending_migrations: [...s.migrations.values()]
        .filter((plan) => plan.pending.size)
        .map((plan) => ({ plan_id: plan.plan_id, kind: plan.kind, pending_entitlement_ids: [...plan.pending] })),
      open_obligations: [...s.obligations.values()]
        .filter((item) => item.status === "open")
        .map((item) => ({
          obligation_id: item.obligation_id, entitlement_id: item.entitlement_id,
          passenger_id: item.passenger_id, reason: item.reason,
        })),
      pending_compensations: [...s.compensations.values()]
        .filter((item) => item.status === "offered")
        .map((item) => ({
          compensation_id: item.compensation_id, obligation_id: item.obligation_id,
          passenger_id: item.passenger_id, kind: item.kind,
        })),
      frozen_entitlements: [...s.freezes.entries()]
        .map(([entitlement_id, freeze]) => ({ entitlement_id, ...freeze })),
      conflicts: [...s.conflicts],
    };
  }

  /** 旅客账单：最终可领取项目、每次变更依据、未兑现责任、受影响批次。 */
  passengerStatement(passengerId) {
    const passenger = this.#state.passengers.get(String(passengerId));
    if (!passenger) throw new Error(`旅客未登记：${passengerId}`);
    const ents = [...this.#state.entitlements.values()].filter((item) => item.passenger_id === passengerId);
    const view = (item) => ({
      entitlement_id: item.entitlement_id, kind: item.kind, state: item.state,
      flight_id: item.flight_id,
      ...(item.station_id ? { station_id: item.station_id } : {}),
      ...(item.batch_id ? { batch_id: item.batch_id } : {}),
      ...(item.staff_id ? { staff_id: item.staff_id } : {}),
    });
    const unfulfilled = [...this.#state.obligations.values()]
      .filter((item) => item.passenger_id === passengerId && item.status === "open")
      .map((item) => ({
        obligation_id: item.obligation_id, entitlement_id: item.entitlement_id,
        kind: item.kind, reason: item.reason, basis_event_id: item.basis_event_id,
        compensation: this.#compensationView(item.compensation_id),
      }));
    const changes = ents
      .flatMap((item) => item.history.map((h) => ({ entitlement_id: item.entitlement_id, ...h })))
      .sort((a, b) => a.seq - b.seq)
      .map(({ seq, ...rest }) => rest);
    return {
      passenger_id: passengerId,
      claimable: ents.filter((item) => item.state === "confirmed").map(view),
      pending: ents.filter((item) => item.state === "reserved").map(view),
      redeemed: ents.filter((item) => item.state === "redeemed").map(view),
      unfulfilled,
      changes,
      affected_batches: this.#affectedBatches(passengerId, ents),
      frozen: ents
        .filter((item) => this.#state.freezes.has(item.entitlement_id))
        .map((item) => ({ entitlement_id: item.entitlement_id, ...this.#state.freezes.get(item.entitlement_id) })),
    };
  }

  #compensationView(compensationId) {
    if (!compensationId) return null;
    const comp = this.#state.compensations.get(compensationId);
    if (!comp) return null;
    return {
      compensation_id: comp.compensation_id, status: comp.status,
      kind: comp.kind, detail: comp.detail,
    };
  }

  #affectedBatches(passengerId, ents) {
    const impacts = new Map(); // batch_id -> Set(影响)
    const mark = (batchId, label) => {
      if (!batchId) return;
      if (!impacts.has(batchId)) impacts.set(batchId, new Set());
      impacts.get(batchId).add(label);
    };
    for (const item of ents) {
      for (const batchId of item.batch_trail) {
        const batch = this.#state.batches.get(batchId);
        if (batch?.recalled) mark(batchId, "已召回");
        if (this.#state.freezes.has(item.entitlement_id)) mark(batchId, "已冻结");
      }
    }
    for (const sub of this.#state.substitutions.values()) {
      const owner = this.#state.entitlements.get(sub.entitlement_id);
      if (owner?.passenger_id === passengerId && sub.status === "approved") {
        mark(sub.original_batch_id, "已替换");
        mark(sub.replacement_batch_id, "替换生效");
      }
    }
    for (const ob of this.#state.obligations.values()) {
      if (ob.passenger_id === passengerId && ob.status === "open" && ob.batch_id) mark(ob.batch_id, "未兑现");
    }
    return [...impacts.entries()].map(([batch_id, labels]) => {
      const batch = this.#state.batches.get(batch_id);
      return {
        batch_id,
        ...(batch ? { supplier_id: batch.supplier_id, high_risk: batch.high_risk } : {}),
        impacts: [...labels],
      };
    });
  }

  /* ---------- 份额池 ---------- */

  #poolOf(kind, ref) {
    if (kind === "lounge_access") return { key: `lounge:${ref}`, capacity: this.#state.stations.get(ref)?.capacity ?? 0 };
    if (kind === "festival_food") return { key: `batch:${ref}`, capacity: this.#state.batches.get(ref)?.quantity ?? 0 };
    return { key: `staff:${ref}`, capacity: this.#state.staff.get(ref)?.sessions ?? 0 };
  }

  #poolRef(item) {
    if (item.kind === "lounge_access") return item.station_id;
    if (item.kind === "festival_food") return item.batch_id;
    return item.staff_id;
  }

  #poolUsage(kind, ref) {
    const { key } = this.#poolOf(kind, ref);
    let used = 0;
    for (const item of this.#state.entitlements.values()) {
      if (ACTIVE_STATES.includes(item.state) && this.#poolOf(item.kind, this.#poolRef(item)).key === key) used += 1;
    }
    return used;
  }

  #assertCapacity(kind, ref) {
    const { capacity } = this.#poolOf(kind, ref);
    if (this.#poolUsage(kind, ref) >= capacity) {
      throw new Error(`可用份额不足：${KIND_LABEL[kind]} ${ref} 容量 ${capacity}`);
    }
  }

  #assertNotFrozen(entitlementId) {
    const freeze = this.#state.freezes.get(entitlementId);
    if (freeze) throw new Error(`服务包已冻结：${entitlementId}（${freeze.reason}）`);
  }

  #assertAllergenClear(passengerId, batch) {
    const passenger = this.#state.passengers.get(passengerId);
    const conflict = allergenConflict(passenger?.allergens ?? [], batch.allergens);
    if (conflict.length) throw new Error(`旅客过敏原与批次声明冲突：${conflict.join("、")}`);
  }

  /* ---------- 业务校验 ---------- */

  #validate(event) {
    const p = event.payload ?? {};
    const s = this.#state;
    switch (event.type) {
      case "passenger_registered":
        requireFields(p, ["passenger_id"]);
        break;
      case "flight_registered": {
        requireFields(p, ["flight_id", "version", "origin", "destination"]);
        const flight = s.flights.get(p.flight_id);
        if (flight?.versions.has(Number(p.version))) throw new Error(`航班版本已登记：${p.flight_id} v${p.version}`);
        break;
      }
      case "station_registered":
        requireFields(p, ["station_id", "airport", "capacity"]);
        if (s.stations.has(p.station_id)) throw new Error(`站点已登记：${p.station_id}`);
        break;
      case "batch_registered":
        requireFields(p, ["batch_id", "supplier_id", "quantity"]);
        if (s.batches.has(p.batch_id)) throw new Error(`批次已登记：${p.batch_id}`);
        break;
      case "batch_recalled": {
        requireFields(p, ["batch_id", "reason"]);
        const batch = s.batches.get(p.batch_id);
        if (!batch) throw new Error(`批次不存在：${p.batch_id}`);
        if (batch.recalled) throw new Error(`批次已召回：${p.batch_id}`);
        break;
      }
      case "staff_registered":
        requireFields(p, ["staff_id", "sessions"]);
        if (s.staff.has(p.staff_id)) throw new Error(`活动人员已登记：${p.staff_id}`);
        break;
      case "staff_cancelled": {
        requireFields(p, ["staff_id"]);
        const member = s.staff.get(p.staff_id);
        if (!member) throw new Error(`活动人员不存在：${p.staff_id}`);
        if (!member.active) throw new Error(`活动人员已取消：${p.staff_id}`);
        break;
      }
      case "destination_rule_registered":
        requireFields(p, ["airport", "kind"]);
        if (!ENTITLEMENT_KINDS.includes(p.kind)) throw new Error(`未知权益种类：${p.kind}`);
        break;
      case "loading_recorded":
        requireFields(p, ["flight_id", "version", "batch_id", "quantity"]);
        if (!s.flights.has(p.flight_id)) throw new Error(`航班未登记：${p.flight_id}`);
        if (!s.batches.has(p.batch_id)) throw new Error(`批次不存在：${p.batch_id}`);
        break;
      case "entitlement_reserved": {
        requireFields(p, ["entitlement_id", "passenger_id", "flight_id", "kind"]);
        if (!ENTITLEMENT_KINDS.includes(p.kind)) throw new Error(`未知权益种类：${p.kind}`);
        if (s.entitlements.has(p.entitlement_id)) throw new Error(`权益编号已存在：${p.entitlement_id}`);
        if (!s.passengers.has(p.passenger_id)) throw new Error(`旅客未登记：${p.passenger_id}`);
        if (!s.flights.has(p.flight_id)) throw new Error(`航班未登记：${p.flight_id}`);
        if (p.kind === "lounge_access") {
          requireFields(p, ["station_id"]);
          if (!s.stations.has(p.station_id)) throw new Error(`站点不存在：${p.station_id}`);
          this.#assertCapacity(p.kind, p.station_id);
        } else if (p.kind === "festival_food") {
          requireFields(p, ["batch_id"]);
          const batch = s.batches.get(p.batch_id);
          if (!batch) throw new Error(`批次不存在：${p.batch_id}`);
          if (batch.recalled) throw new Error(`批次已召回，不可预留：${p.batch_id}`);
          this.#assertAllergenClear(p.passenger_id, batch);
          this.#assertCapacity(p.kind, p.batch_id);
        } else {
          requireFields(p, ["staff_id"]);
          const member = s.staff.get(p.staff_id);
          if (!member) throw new Error(`活动人员不存在：${p.staff_id}`);
          if (!member.active) throw new Error(`活动人员已取消：${p.staff_id}`);
          if (!member.qualifications.includes("heritage_demo")) throw new Error(`活动人员资质不符：${p.staff_id}`);
          this.#assertCapacity(p.kind, p.staff_id);
        }
        break;
      }
      case "entitlement_confirmed": {
        requireFields(p, ["entitlement_id"]);
        const item = this.#mustEntitlement(p.entitlement_id);
        this.#assertNotFrozen(item.entitlement_id);
        if (item.state !== "reserved") throw new Error(`当前状态不可确认：${item.state}`);
        if (item.kind === "festival_food") {
          const batch = s.batches.get(item.batch_id);
          if (batch?.recalled) throw new Error(`批次已召回，不可确认：${item.batch_id}`);
          this.#assertAllergenClear(item.passenger_id, batch);
        }
        break;
      }
      case "entitlement_redeemed": {
        requireFields(p, ["entitlement_id"]);
        const item = this.#mustEntitlement(p.entitlement_id);
        this.#assertNotFrozen(item.entitlement_id);
        if (item.state !== "confirmed") throw new Error(`仅已确认权益可核销，当前状态：${item.state}`);
        break;
      }
      case "entitlement_released": {
        requireFields(p, ["entitlement_id"]);
        const item = this.#mustEntitlement(p.entitlement_id);
        this.#assertNotFrozen(item.entitlement_id);
        if (!ACTIVE_STATES.includes(item.state)) throw new Error(`当前状态不可释放：${item.state}`);
        break;
      }
      case "flights_merged": {
        requireFields(p, ["merge_id", "source_flight_ids", "target_flight_id"]);
        if (s.migrations.has(p.merge_id)) throw new Error(`拆并方案已存在：${p.merge_id}`);
        if (p.source_flight_ids.includes(p.target_flight_id)) throw new Error("目标航班不能同时是来源航班");
        for (const id of p.source_flight_ids) {
          if (!s.flights.has(id)) throw new Error(`航班未登记：${id}`);
        }
        if (!s.flights.has(p.target_flight_id)) throw new Error(`航班未登记：${p.target_flight_id}`);
        break;
      }
      case "flight_split": {
        requireFields(p, ["split_id", "source_flight_id", "parts"]);
        if (s.migrations.has(p.split_id)) throw new Error(`拆并方案已存在：${p.split_id}`);
        if (!s.flights.has(p.source_flight_id)) throw new Error(`航班未登记：${p.source_flight_id}`);
        for (const part of p.parts) requireFields(part, ["flight_id"]);
        break;
      }
      case "substitution_proposed": {
        requireFields(p, ["substitution_id", "entitlement_id", "replacement_batch_id", "proposer"]);
        requireFields(p.proposer, ["actor_id", "role"]);
        if (s.substitutions.has(p.substitution_id)) throw new Error(`替代方案已存在：${p.substitution_id}`);
        const item = this.#mustEntitlement(p.entitlement_id);
        this.#assertNotFrozen(item.entitlement_id);
        if (item.kind !== "festival_food") throw new Error("仅节日食品权益可替换批次");
        if (![...ACTIVE_STATES, "unfulfilled"].includes(item.state)) throw new Error(`当前状态不可替换：${item.state}`);
        const replacement = s.batches.get(p.replacement_batch_id);
        if (!replacement) throw new Error(`批次不存在：${p.replacement_batch_id}`);
        if (replacement.recalled) throw new Error(`批次已召回，不可作为替代：${p.replacement_batch_id}`);
        this.#assertAllergenClear(item.passenger_id, replacement);
        this.#assertCapacity("festival_food", p.replacement_batch_id);
        break;
      }
      case "substitution_reviewed": {
        requireFields(p, ["substitution_id", "decision", "reviewer"]);
        requireFields(p.reviewer, ["actor_id", "role"]);
        if (!["approve", "reject"].includes(p.decision)) throw new Error(`未知复核结论：${p.decision}`);
        const sub = s.substitutions.get(p.substitution_id);
        if (!sub) throw new Error(`替代方案不存在：${p.substitution_id}`);
        if (sub.status !== "proposed") throw new Error(`替代方案已复核：${sub.status}`);
        if (p.reviewer.actor_id === sub.proposer.actor_id) throw new Error("提案人与复核人不得为同一人");
        const item = s.entitlements.get(sub.entitlement_id);
        const original = s.batches.get(sub.original_batch_id);
        const replacement = s.batches.get(sub.replacement_batch_id);
        if ((original?.high_risk || replacement?.high_risk) && p.reviewer.role === sub.proposer.role) {
          throw new Error("高风险食品替换需不同角色复核");
        }
        if (p.reviewer.supplier_id && p.reviewer.supplier_id === replacement?.supplier_id) {
          throw new Error("供应方不能批准自身批次");
        }
        if (p.decision === "approve") {
          this.#assertNotFrozen(item.entitlement_id);
          if (replacement.recalled) throw new Error(`批次已召回，不可作为替代：${sub.replacement_batch_id}`);
          this.#assertAllergenClear(item.passenger_id, replacement);
          this.#assertCapacity("festival_food", sub.replacement_batch_id);
        }
        break;
      }
      case "compensation_fulfilled": {
        requireFields(p, ["compensation_id"]);
        const comp = s.compensations.get(p.compensation_id);
        if (!comp) throw new Error(`补偿不存在：${p.compensation_id}`);
        if (comp.status !== "offered") throw new Error(`补偿当前状态不可核销：${comp.status}`);
        break;
      }
      case "freeze_lifted": {
        requireFields(p, ["freeze_id", "entitlement_id"]);
        const freeze = s.freezes.get(p.entitlement_id);
        if (!freeze || freeze.freeze_id !== p.freeze_id) throw new Error(`冻结记录不存在：${p.entitlement_id}`);
        break;
      }
      default:
        // 派生事件（entitlement_migrated / obligation_recorded / compensation_offered / packages_frozen）
        // 由系统内部生成，不在外部入口校验。
        throw new Error(`事件类型不可外部提交：${event.type}`);
    }
  }

  #mustEntitlement(entitlementId) {
    const item = this.#state.entitlements.get(entitlementId);
    if (!item) throw new Error(`权益不存在：${entitlementId}`);
    return item;
  }

  /* ---------- 状态折叠 ---------- */

  #fold(entry) {
    const p = entry.payload;
    const s = this.#state;
    this.#seq += 1;
    const seq = this.#seq;
    const at = entry.recorded_at;
    const pushHistory = (item, basis, detail = {}) => {
      item.history.push({ seq, at, event_id: entry.event_id, basis, ...detail });
    };
    switch (entry.type) {
      case "passenger_registered":
        s.passengers.set(p.passenger_id, { allergens: [...(p.allergens ?? [])] });
        break;
      case "flight_registered": {
        const flight = s.flights.get(p.flight_id) ?? { versions: new Map(), current: 0 };
        const version = Number(p.version);
        flight.versions.set(version, {
          version, origin: p.origin, destination: p.destination, aircraft: p.aircraft ?? null,
        });
        flight.current = Math.max(flight.current, version);
        s.flights.set(p.flight_id, flight);
        break;
      }
      case "station_registered":
        s.stations.set(p.station_id, { airport: p.airport, capacity: Number(p.capacity) });
        break;
      case "batch_registered":
        s.batches.set(p.batch_id, {
          supplier_id: p.supplier_id, kind: p.kind ?? "festival_food",
          allergens: [...(p.allergens ?? [])], high_risk: Boolean(p.high_risk),
          quantity: Number(p.quantity), recalled: null,
        });
        break;
      case "batch_recalled": {
        const batch = s.batches.get(p.batch_id);
        batch.recalled = { reason: p.reason, event_id: entry.event_id };
        break;
      }
      case "staff_registered":
        s.staff.set(p.staff_id, {
          qualifications: [...(p.qualifications ?? [])], sessions: Number(p.sessions), active: true,
        });
        break;
      case "staff_cancelled":
        s.staff.get(p.staff_id).active = false;
        break;
      case "destination_rule_registered":
        s.rules.set(`${p.airport}:${p.kind}`, { allowed: p.allowed !== false, note: p.note ?? "" });
        break;
      case "loading_recorded": {
        const key = `${p.flight_id}:${Number(p.version)}:${p.batch_id}`;
        const record = s.loadings.get(key) ?? { quantity: 0 };
        record.quantity += Number(p.quantity);
        s.loadings.set(key, record);
        break;
      }
      case "entitlement_reserved": {
        const item = {
          entitlement_id: p.entitlement_id, passenger_id: p.passenger_id, kind: p.kind,
          flight_id: p.flight_id, state: "reserved",
          station_id: p.station_id ?? null, batch_id: p.batch_id ?? null, staff_id: p.staff_id ?? null,
          batch_trail: new Set(p.batch_id ? [p.batch_id] : []),
          history: [],
        };
        pushHistory(item, `预留登记，占用${KIND_LABEL[p.kind]}唯一份额`);
        s.entitlements.set(item.entitlement_id, item);
        break;
      }
      case "entitlement_confirmed": {
        const item = s.entitlements.get(p.entitlement_id);
        item.state = "confirmed";
        pushHistory(item, "确认占用唯一份额");
        break;
      }
      case "entitlement_redeemed": {
        const item = s.entitlements.get(p.entitlement_id);
        item.state = "redeemed";
        pushHistory(item, "现场核销，事实保留不再迁移");
        break;
      }
      case "entitlement_released": {
        const item = s.entitlements.get(p.entitlement_id);
        item.state = "released";
        pushHistory(item, `释放份额${p.reason ? `：${p.reason}` : ""}`);
        break;
      }
      case "flights_merged": {
        const pending = [...s.entitlements.values()]
          .filter((item) => ACTIVE_STATES.includes(item.state) && p.source_flight_ids.includes(item.flight_id))
          .map((item) => item.entitlement_id);
        s.migrations.set(p.merge_id, {
          plan_id: p.merge_id, kind: "merge", target_flight_id: p.target_flight_id,
          target_by_passenger: {}, pending: new Set(pending), settled: new Map(),
          basis_event_id: entry.event_id,
        });
        break;
      }
      case "flight_split": {
        const source = s.flights.get(p.source_flight_id);
        const current = source.versions.get(source.current);
        const targetByPassenger = {};
        for (const part of p.parts) {
          if (!s.flights.has(part.flight_id)) {
            s.flights.set(part.flight_id, {
              versions: new Map([[1, {
                version: 1,
                origin: part.origin ?? current.origin,
                destination: part.destination ?? current.destination,
                aircraft: current.aircraft,
              }]]),
              current: 1,
            });
          }
          for (const passengerId of part.passenger_ids ?? []) targetByPassenger[passengerId] = part.flight_id;
        }
        const pending = [...s.entitlements.values()]
          .filter((item) => ACTIVE_STATES.includes(item.state) && item.flight_id === p.source_flight_id)
          .map((item) => item.entitlement_id);
        s.migrations.set(p.split_id, {
          plan_id: p.split_id, kind: "split", target_flight_id: null,
          target_by_passenger: targetByPassenger, pending: new Set(pending), settled: new Map(),
          basis_event_id: entry.event_id,
        });
        break;
      }
      case "entitlement_migrated": {
        const item = s.entitlements.get(p.entitlement_id);
        item.flight_id = p.to_flight_id;
        pushHistory(item, `航班拆并迁移 ${p.from_flight_id} → ${p.to_flight_id}：${p.basis}`);
        this.#markSettled(p.plan_id, p.entitlement_id, "migrated");
        break;
      }
      case "obligation_recorded": {
        const item = s.entitlements.get(p.entitlement_id);
        if (item && ACTIVE_STATES.includes(item.state)) {
          item.state = "unfulfilled";
          pushHistory(item, `未兑现：${p.reason}`, p.batch_id ? { batch_id: p.batch_id } : {});
        }
        const trailBatch = p.batch_id ?? item?.batch_id;
        if (item && trailBatch) item.batch_trail.add(trailBatch);
        s.obligations.set(p.obligation_id, {
          ...p, status: "open", compensation_id: null, basis_event_id: p.basis_event_id ?? entry.event_id,
        });
        if (p.plan_id) this.#markSettled(p.plan_id, p.entitlement_id, "obligation");
        break;
      }
      case "compensation_offered": {
        s.compensations.set(p.compensation_id, { ...p, status: "offered" });
        const obligation = s.obligations.get(p.obligation_id);
        if (obligation) obligation.compensation_id = p.compensation_id;
        break;
      }
      case "compensation_fulfilled": {
        const comp = s.compensations.get(p.compensation_id);
        comp.status = "fulfilled";
        const obligation = s.obligations.get(comp.obligation_id);
        if (obligation) obligation.status = "compensated";
        break;
      }
      case "substitution_proposed": {
        const item = s.entitlements.get(p.entitlement_id);
        s.substitutions.set(p.substitution_id, {
          substitution_id: p.substitution_id, entitlement_id: p.entitlement_id,
          original_batch_id: item.batch_id, replacement_batch_id: p.replacement_batch_id,
          proposer: { ...p.proposer }, status: "proposed",
        });
        break;
      }
      case "substitution_reviewed": {
        const sub = s.substitutions.get(p.substitution_id);
        sub.status = p.decision === "approve" ? "approved" : "rejected";
        sub.reviewer = { ...p.reviewer };
        if (sub.status === "approved") {
          const item = s.entitlements.get(sub.entitlement_id);
          const from = item.batch_id;
          item.batch_id = sub.replacement_batch_id;
          item.batch_trail.add(sub.replacement_batch_id);
          if (item.state === "unfulfilled") {
            item.state = "reserved";
            for (const ob of s.obligations.values()) {
              if (ob.entitlement_id === item.entitlement_id && ob.status === "open") {
                ob.status = "resolved_by_substitution";
                const comp = s.compensations.get(ob.compensation_id);
                if (comp && comp.status === "offered") comp.status = "voided";
              }
            }
          }
          pushHistory(item, `批次替换经 ${p.reviewer.role} 复核批准：${from} → ${sub.replacement_batch_id}`);
        }
        break;
      }
      case "packages_frozen":
        for (const entitlementId of p.entitlement_ids) {
          s.freezes.set(entitlementId, {
            freeze_id: p.freeze_id, reason: p.reason, conflicting_event_id: p.conflicting_event_id,
          });
        }
        break;
      case "freeze_lifted":
        s.freezes.delete(p.entitlement_id);
        break;
      default:
        throw new Error(`无法折叠未知事件：${entry.type}`);
    }
  }

  #markSettled(planId, entitlementId, outcome) {
    const plan = this.#state.migrations.get(planId);
    if (!plan) return;
    plan.pending.delete(entitlementId);
    plan.settled.set(entitlementId, outcome);
  }

  /* ---------- 派生事件（迁移结算、召回/取消善后） ---------- */

  #appendDerived(event) {
    const result = this.ledger.append(event);
    if (result.status === "applied") this.#fold(result.event);
    return result.status;
  }

  #derive(entry) {
    const derived = [];
    const emit = (event) => {
      if (this.#appendDerived(event) === "applied") derived.push(event.event_id);
    };
    const s = this.#state;
    if (entry.type === "flights_merged" || entry.type === "flight_split") {
      this.#settlePlan(s.migrations.get(entry.payload.merge_id ?? entry.payload.split_id), emit);
    } else if (entry.type === "batch_recalled") {
      const { batch_id, reason } = entry.payload;
      for (const item of s.entitlements.values()) {
        if (item.batch_id === batch_id && ACTIVE_STATES.includes(item.state)) {
          this.#emitObligation(emit, {
            obligationId: `recall:${batch_id}:${item.entitlement_id}`,
            item, reason: `批次召回：${reason}`, batchId: batch_id, basisEventId: entry.event_id,
          });
        }
      }
    } else if (entry.type === "staff_cancelled") {
      const { staff_id } = entry.payload;
      for (const item of s.entitlements.values()) {
        if (item.staff_id === staff_id && ACTIVE_STATES.includes(item.state)) {
          this.#emitObligation(emit, {
            obligationId: `staff-cancel:${staff_id}:${item.entitlement_id}`,
            item, reason: `活动人员已取消：${staff_id}`, batchId: null, basisEventId: entry.event_id,
          });
        }
      }
    }
    return derived;
  }

  #emitObligation(emit, { obligationId, item, reason, batchId, planId = null, basisEventId }) {
    emit({
      event_id: obligationId,
      type: "obligation_recorded",
      payload: {
        obligation_id: obligationId, entitlement_id: item.entitlement_id,
        passenger_id: item.passenger_id, kind: item.kind, reason,
        ...(batchId ? { batch_id: batchId } : {}),
        ...(planId ? { plan_id: planId } : {}),
        basis_event_id: basisEventId,
      },
    });
    emit({
      event_id: `${obligationId}:compensation`,
      type: "compensation_offered",
      payload: {
        compensation_id: `${obligationId}:compensation`, obligation_id: obligationId,
        passenger_id: item.passenger_id, kind: "voucher", detail: "等值节日服务补偿券",
      },
    });
  }

  /** 结算迁移方案中仍待处理的权益（重放安全，可崩溃后续办）。 */
  #settlePlan(plan, emit = null) {
    const emitFn = emit ?? ((event) => this.#appendDerived(event));
    for (const entitlementId of [...plan.pending]) {
      const item = this.#state.entitlements.get(entitlementId);
      if (!item || !ACTIVE_STATES.includes(item.state)) {
        plan.pending.delete(entitlementId);
        continue;
      }
      const targetFlightId = plan.kind === "merge"
        ? plan.target_flight_id
        : plan.target_by_passenger[item.passenger_id] ?? null;
      const reasons = targetFlightId
        ? this.#fulfillability(item, targetFlightId)
        : ["拆并方案未覆盖该旅客"];
      if (reasons.length === 0) {
        emitFn({
          event_id: `${plan.plan_id}:migrate:${entitlementId}`,
          type: "entitlement_migrated",
          payload: {
            plan_id: plan.plan_id, entitlement_id: entitlementId,
            from_flight_id: item.flight_id, to_flight_id: targetFlightId,
            basis: "仍可兑现且符合目的地规则",
          },
        });
      } else {
        this.#emitObligation(emitFn, {
          obligationId: `${plan.plan_id}:obligation:${entitlementId}`,
          item, reason: reasons.join("；"),
          batchId: item.kind === "festival_food" ? item.batch_id : null,
          planId: plan.plan_id, basisEventId: plan.basis_event_id,
        });
      }
    }
  }

  /** 权益在目标航班当前版本上是否仍可兑现，返回失败原因列表（空为可兑现）。 */
  #fulfillability(item, flightId) {
    const s = this.#state;
    const flight = s.flights.get(flightId);
    const current = flight.versions.get(flight.current);
    const reasons = [];
    const rule = s.rules.get(`${current.destination}:${item.kind}`);
    if (rule && !rule.allowed) {
      reasons.push(`目的地 ${current.destination} 规则不允许${KIND_LABEL[item.kind]}${rule.note ? `（${rule.note}）` : ""}`);
    }
    if (item.kind === "lounge_access") {
      const station = s.stations.get(item.station_id);
      if (!station) reasons.push(`休息室站点不存在：${item.station_id}`);
      else if (station.airport !== current.origin) {
        reasons.push(`休息室站点 ${item.station_id} 不服务新始发地 ${current.origin}`);
      }
    } else if (item.kind === "festival_food") {
      const batch = s.batches.get(item.batch_id);
      if (!batch) {
        reasons.push(`批次不存在：${item.batch_id}`);
      } else {
        if (batch.recalled) reasons.push(`批次已召回：${item.batch_id}`);
        const conflict = allergenConflict(
          s.passengers.get(item.passenger_id)?.allergens ?? [], batch.allergens,
        );
        if (conflict.length) reasons.push(`旅客过敏原与批次声明冲突：${conflict.join("、")}`);
        if (!s.loadings.has(`${flightId}:${flight.current}:${item.batch_id}`)) {
          reasons.push(`航班 ${flightId} 版本 ${flight.current} 无批次 ${item.batch_id} 的装载交接`);
        }
      }
    } else if (item.kind === "heritage_demo") {
      const member = s.staff.get(item.staff_id);
      if (!member || !member.active) reasons.push(`活动人员已取消：${item.staff_id}`);
      else if (!member.qualifications.includes("heritage_demo")) reasons.push(`活动人员资质不符：${item.staff_id}`);
    }
    return reasons;
  }

  /* ---------- 冲突冻结 ---------- */

  #freezeConflict(incoming, replay) {
    const s = this.#state;
    const related = new Set();
    const collect = (payload) => {
      if (!payload) return;
      if (payload.entitlement_id) related.add(payload.entitlement_id);
      for (const id of payload.entitlement_ids ?? []) related.add(id);
      const flightIds = [payload.flight_id, payload.target_flight_id, ...(payload.source_flight_ids ?? [])].filter(Boolean);
      for (const item of s.entitlements.values()) {
        if (!ACTIVE_STATES.includes(item.state)) continue;
        if (payload.passenger_id && item.passenger_id === payload.passenger_id) related.add(item.entitlement_id);
        if (flightIds.includes(item.flight_id)) related.add(item.entitlement_id);
        if (payload.batch_id && item.batch_id === payload.batch_id) related.add(item.entitlement_id);
      }
    };
    collect(replay.event.payload);
    collect(incoming.payload);
    const freezeId = `freeze:${incoming.event_id}`;
    this.#appendDerived({
      event_id: freezeId,
      type: "packages_frozen",
      payload: {
        freeze_id: freezeId, entitlement_ids: [...related],
        reason: `事件 ${incoming.event_id} 编号相同而载荷不同，冻结相关服务包待人工核查`,
        conflicting_event_id: incoming.event_id,
        expected_hash: replay.event.hash, received_hash: replay.received_hash,
      },
    });
    const recorded = this.#state.conflicts.some(
      (item) => item.event_id === incoming.event_id && item.received_hash === replay.received_hash,
    );
    if (!recorded) {
      this.#state.conflicts.push({
        event_id: incoming.event_id, expected_hash: replay.event.hash,
        received_hash: replay.received_hash, frozen: [...related],
      });
    }
    return { status: "conflict_frozen", event_id: incoming.event_id, frozen: [...related] };
  }
}
