/**
 * 节日航班服务包重排调度服务。
 *
 * 以事件账为唯一事实来源，连接航班版本、旅客资格、休息室站点、物料批次、
 * 过敏原声明、活动人员资质、装载交接与替代方案：
 * - 每项权益从预留到确认持有唯一可用份额，确认不二次占用；
 * - 航班拆并只迁移仍可兑现且符合目的地规则的权益，已核销体验保持原事实；
 * - 同一运行事件重放不二次占用，编号相同载荷不同则冻结相关服务包；
 * - 高风险食品替换须不同角色复核，供应方不能批准自身批次；
 * - 进程重启后从事件账恢复未完成的迁移与补偿。
 */
import { EventLedger, hashPayload } from "./ledger.js";

const FOOD_TYPES = new Set(["meal", "snack"]);
const ITEM_TYPES = new Set(["lounge", "meal", "snack", "activity"]);
const MIGRATABLE_STATES = new Set(["reserved", "confirmed"]);

function now() { return new Date().toISOString(); }

function pick(input, keys) {
  const out = {};
  for (const key of keys) if (input[key] !== undefined) out[key] = input[key];
  return out;
}

function requireFields(payload, fields) {
  const missing = fields.filter((f) => payload[f] === undefined || payload[f] === null || payload[f] === "");
  if (missing.length) throw new Error(`缺少必要字段：${missing.join("、")}`);
}

function requirePositiveInt(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} 必须是正整数`);
}

function freshState() {
  return {
    flights: new Map(),       // flight_version_id -> { flight_id, version, destination, station_id, rules }
    stations: new Map(),      // station_id -> { capacity, shares:Set, next }
    batches: new Map(),       // batch_id -> { supplier_id, item_type, high_risk, allergens:null|[...], quantity, loaded, shares:Set, next }
    staff: new Map(),         // staff_id -> { qualifications:[], capacity, shares:Set, next }
    loadings: [],             // 装载交接 { handover_id, flight_version_id, batch_id, quantity }
    assignments: [],          // 活动人员排班 { flight_version_id, staff_id }
    passengers: new Map(),    // passenger_id -> { allergens:[] }
    packages: new Map(),      // package_id -> { passenger_id, flight_version_id, status, entitlement_ids:[] }
    entitlements: new Map(),  // entitlement_id -> { ..., state, share, last_share }
    migrations: new Map(),    // migration_id -> { from, to, queue:[], status }
    liabilities: new Map(),   // liability_id -> { passenger_id, entitlement_id, item_type, reason, status, substitution_id }
    substitutions: new Map(), // substitution_id -> { liability_id, replacement_batch_id, proposer, requires_approval, status, approver, failure }
    changes: new Map(),       // entitlement_id -> [ { seq, event_id, type, summary } ]
  };
}

/** 批次对旅客是否过敏原安全；航班要求声明时，未声明批次一律不可用。 */
function allergenSafe(batch, passenger, flight) {
  if (batch.allergens === null && flight?.rules?.allergen_declaration_required) return false;
  const declared = batch.allergens ?? [];
  return !declared.some((a) => (passenger?.allergens ?? []).includes(a));
}

export class SchedulingService {
  /** 构造即重放事件账并恢复未完成的迁移与补偿。 */
  constructor(ledger = new EventLedger()) {
    this.ledger = ledger;
    this.state = freshState();
    for (const event of this.ledger.all()) this.#reduce(event);
    this.recovery = this.#recover();
  }

  health() {
    return { service: "festival_flight_scheduling", status: "ok", events: this.ledger.size };
  }

  // ---------- 基础档案登记 ----------

  registerFlightVersion(input) {
    const payload = pick(input, ["flight_version_id", "flight_id", "version", "destination", "station_id", "rules"]);
    requireFields(payload, ["flight_version_id", "flight_id", "destination"]);
    if (this.#checkReplay(input.event_id, payload)) return this.state.flights.get(payload.flight_version_id);
    if (this.state.flights.has(payload.flight_version_id)) throw new Error(`航班版本已存在：${payload.flight_version_id}`);
    this.#appendAndReduce({ event_id: input.event_id, type: "flight_version_registered", occurred_at: input.occurred_at ?? now(), payload });
    return this.state.flights.get(payload.flight_version_id);
  }

  registerStation(input) {
    const payload = pick(input, ["station_id", "name", "capacity"]);
    requireFields(payload, ["station_id"]);
    requirePositiveInt(payload.capacity, "休息室容量");
    if (this.#checkReplay(input.event_id, payload)) return this.state.stations.get(payload.station_id);
    if (this.state.stations.has(payload.station_id)) throw new Error(`休息室站点已存在：${payload.station_id}`);
    this.#appendAndReduce({ event_id: input.event_id, type: "station_registered", occurred_at: input.occurred_at ?? now(), payload });
    return this.state.stations.get(payload.station_id);
  }

  registerBatch(input) {
    const payload = pick(input, ["batch_id", "supplier_id", "item_type", "quantity", "high_risk", "allergens"]);
    requireFields(payload, ["batch_id", "supplier_id", "item_type"]);
    requirePositiveInt(payload.quantity, "批次数量");
    if (payload.allergens !== undefined && !Array.isArray(payload.allergens)) throw new Error("过敏原声明必须是数组");
    if (this.#checkReplay(input.event_id, payload)) return this.state.batches.get(payload.batch_id);
    if (this.state.batches.has(payload.batch_id)) throw new Error(`物料批次已存在：${payload.batch_id}`);
    this.#appendAndReduce({ event_id: input.event_id, type: "batch_registered", occurred_at: input.occurred_at ?? now(), payload });
    return this.state.batches.get(payload.batch_id);
  }

  /** 过敏原声明：补充或更正批次声明，声明后参与安全校验。 */
  declareAllergens(input) {
    const payload = pick(input, ["batch_id", "allergens"]);
    requireFields(payload, ["batch_id"]);
    if (!Array.isArray(payload.allergens)) throw new Error("过敏原声明必须是数组");
    if (this.#checkReplay(input.event_id, payload)) return this.state.batches.get(payload.batch_id);
    if (!this.state.batches.has(payload.batch_id)) throw new Error(`物料批次不存在：${payload.batch_id}`);
    this.#appendAndReduce({ event_id: input.event_id, type: "allergens_declared", occurred_at: input.occurred_at ?? now(), payload });
    return this.state.batches.get(payload.batch_id);
  }

  registerStaff(input) {
    const payload = pick(input, ["staff_id", "qualifications", "capacity"]);
    requireFields(payload, ["staff_id"]);
    if (!Array.isArray(payload.qualifications)) throw new Error("活动人员资质必须是数组");
    requirePositiveInt(payload.capacity, "活动人员容量");
    if (this.#checkReplay(input.event_id, payload)) return this.state.staff.get(payload.staff_id);
    if (this.state.staff.has(payload.staff_id)) throw new Error(`活动人员已存在：${payload.staff_id}`);
    this.#appendAndReduce({ event_id: input.event_id, type: "staff_registered", occurred_at: input.occurred_at ?? now(), payload });
    return this.state.staff.get(payload.staff_id);
  }

  assignStaff(input) {
    const payload = pick(input, ["flight_version_id", "staff_id"]);
    requireFields(payload, ["flight_version_id", "staff_id"]);
    if (this.#checkReplay(input.event_id, payload)) return { assigned: true };
    if (!this.state.flights.has(payload.flight_version_id)) throw new Error(`航班版本不存在：${payload.flight_version_id}`);
    if (!this.state.staff.has(payload.staff_id)) throw new Error(`活动人员不存在：${payload.staff_id}`);
    this.#appendAndReduce({ event_id: input.event_id, type: "staff_assigned", occurred_at: input.occurred_at ?? now(), payload });
    return { assigned: true };
  }

  /** 装载交接：把批次数量装上航班版本，累计不得超过批次总量。 */
  recordHandover(input) {
    const payload = pick(input, ["handover_id", "flight_version_id", "batch_id", "quantity"]);
    requireFields(payload, ["handover_id", "flight_version_id", "batch_id"]);
    requirePositiveInt(payload.quantity, "交接数量");
    if (this.#checkReplay(input.event_id, payload)) return { recorded: true };
    if (!this.state.flights.has(payload.flight_version_id)) throw new Error(`航班版本不存在：${payload.flight_version_id}`);
    const batch = this.state.batches.get(payload.batch_id);
    if (!batch) throw new Error(`物料批次不存在：${payload.batch_id}`);
    if (batch.loaded + payload.quantity > batch.quantity) throw new Error(`装载量超过批次总量：${payload.batch_id}`);
    this.#appendAndReduce({ event_id: input.event_id, type: "handover_recorded", occurred_at: input.occurred_at ?? now(), payload });
    return { recorded: true };
  }

  registerPassenger(input) {
    const payload = pick(input, ["passenger_id", "allergens"]);
    requireFields(payload, ["passenger_id"]);
    if (payload.allergens !== undefined && !Array.isArray(payload.allergens)) throw new Error("旅客过敏原必须是数组");
    if (this.#checkReplay(input.event_id, payload)) return this.state.passengers.get(payload.passenger_id);
    if (this.state.passengers.has(payload.passenger_id)) throw new Error(`旅客已存在：${payload.passenger_id}`);
    this.#appendAndReduce({ event_id: input.event_id, type: "passenger_registered", occurred_at: input.occurred_at ?? now(), payload });
    return this.state.passengers.get(payload.passenger_id);
  }

  registerPackage(input) {
    const payload = pick(input, ["package_id", "passenger_id", "flight_version_id"]);
    requireFields(payload, ["package_id", "passenger_id", "flight_version_id"]);
    if (this.#checkReplay(input.event_id, payload)) return this.state.packages.get(payload.package_id);
    if (this.state.packages.has(payload.package_id)) throw new Error(`服务包已存在：${payload.package_id}`);
    if (!this.state.passengers.has(payload.passenger_id)) throw new Error(`旅客不存在：${payload.passenger_id}`);
    if (!this.state.flights.has(payload.flight_version_id)) throw new Error(`航班版本不存在：${payload.flight_version_id}`);
    this.#appendAndReduce({ event_id: input.event_id, type: "package_registered", occurred_at: input.occurred_at ?? now(), payload });
    return this.state.packages.get(payload.package_id);
  }

  // ---------- 权益生命周期 ----------

  /** 预留权益：占用唯一可用份额；份额由事件派生字段固化，重放不会重新分配。 */
  reserveEntitlement(input) {
    const payload = pick(input, ["entitlement_id", "package_id", "item_type", "activity_kind"]);
    requireFields(payload, ["entitlement_id", "package_id", "item_type"]);
    if (!ITEM_TYPES.has(payload.item_type)) throw new Error(`未知权益类型：${payload.item_type}`);
    if (this.#checkReplay(input.event_id, payload)) return this.state.entitlements.get(payload.entitlement_id);
    if (this.state.entitlements.has(payload.entitlement_id)) throw new Error(`权益已存在：${payload.entitlement_id}`);
    const pkg = this.#requirePackage(payload.package_id);
    const passenger = this.state.passengers.get(pkg.passenger_id);
    const flight = this.state.flights.get(pkg.flight_version_id);
    if (!this.#destinationAllows(flight, payload)) throw new Error(`目的地规则不允许该权益：${flight.destination}`);
    const poolRef = this.#resolvePool(pkg.flight_version_id, payload, passenger);
    if (!poolRef) throw new Error(`无可用份额：${payload.item_type}`);
    const pool = this.#pool(poolRef.kind, poolRef.id);
    const share = { pool_kind: poolRef.kind, pool_id: poolRef.id, share_id: `${poolRef.kind}:${poolRef.id}#${pool.next + 1}` };
    this.#appendAndReduce({
      event_id: input.event_id, type: "entitlement_reserved", occurred_at: input.occurred_at ?? now(),
      payload, derived: { flight_version_id: pkg.flight_version_id, share },
    });
    return this.state.entitlements.get(payload.entitlement_id);
  }

  /** 确认权益：沿用预留时占用的同一份额，不重新占用。 */
  confirmEntitlement(input) {
    const payload = pick(input, ["entitlement_id"]);
    requireFields(payload, ["entitlement_id"]);
    if (this.#checkReplay(input.event_id, payload)) return this.state.entitlements.get(payload.entitlement_id);
    const ent = this.#requireEntitlement(payload.entitlement_id);
    this.#requirePackage(ent.package_id);
    if (ent.state !== "reserved") throw new Error(`权益状态不允许确认：${ent.state}`);
    this.#appendAndReduce({ event_id: input.event_id, type: "entitlement_confirmed", occurred_at: input.occurred_at ?? now(), payload });
    return this.state.entitlements.get(payload.entitlement_id);
  }

  /** 核销权益：形成不可改写的体验事实，航班拆并时保持原样。 */
  redeemEntitlement(input) {
    const payload = pick(input, ["entitlement_id"]);
    requireFields(payload, ["entitlement_id"]);
    if (this.#checkReplay(input.event_id, payload)) return this.state.entitlements.get(payload.entitlement_id);
    const ent = this.#requireEntitlement(payload.entitlement_id);
    this.#requirePackage(ent.package_id);
    if (ent.state !== "confirmed") throw new Error(`权益状态不允许核销：${ent.state}`);
    this.#appendAndReduce({ event_id: input.event_id, type: "entitlement_redeemed", occurred_at: input.occurred_at ?? now(), payload });
    return this.state.entitlements.get(payload.entitlement_id);
  }

  // ---------- 航班拆并迁移 ----------

  /**
   * 航班拆并：把源航班版本上仍处于预留/确认状态的权益迁往目标版本。
   * 已核销体验不在迁移队列中，保持原事实；无法兑现的登记未兑现责任。
   */
  migrateFlight(input) {
    const payload = pick(input, ["migration_id", "from_flight_version_id", "to_flight_version_id"]);
    requireFields(payload, ["migration_id", "from_flight_version_id", "to_flight_version_id"]);
    const duplicate = this.#checkReplay(input.event_id, payload);
    if (!this.state.flights.has(payload.from_flight_version_id)) throw new Error(`航班版本不存在：${payload.from_flight_version_id}`);
    if (!this.state.flights.has(payload.to_flight_version_id)) throw new Error(`航班版本不存在：${payload.to_flight_version_id}`);
    if (payload.from_flight_version_id === payload.to_flight_version_id) throw new Error("源与目标航班版本相同，无需迁移");
    if (!duplicate) {
      const entitlementIds = [...this.state.entitlements.values()]
        .filter((e) => e.flight_version_id === payload.from_flight_version_id && MIGRATABLE_STATES.has(e.state))
        .map((e) => e.entitlement_id);
      this.#appendAndReduce({
        event_id: input.event_id, type: "migration_started", occurred_at: input.occurred_at ?? now(),
        payload, derived: { entitlement_ids: entitlementIds },
      });
    }
    this.#processMigration(payload.migration_id);
    return this.state.migrations.get(payload.migration_id);
  }

  /** 逐项处理迁移队列；派生事件编号确定，重启恢复时重放自动去重。 */
  #processMigration(migrationId) {
    const mig = this.state.migrations.get(migrationId);
    if (!mig || mig.status !== "in_progress") return;
    for (const entitlementId of [...mig.queue]) {
      const ent = this.state.entitlements.get(entitlementId);
      if (!ent || !MIGRATABLE_STATES.has(ent.state)) {
        this.#appendDerived({ event_id: `${migrationId}:${entitlementId}:skipped`, type: "migration_item_skipped", occurred_at: now(), payload: { migration_id: migrationId, entitlement_id: entitlementId } });
        continue;
      }
      const pkg = this.state.packages.get(ent.package_id);
      const passenger = this.state.passengers.get(pkg.passenger_id);
      const flight = this.state.flights.get(mig.to);
      const poolRef = this.#destinationAllows(flight, ent) ? this.#resolvePool(mig.to, ent, passenger) : null;
      if (poolRef) {
        const pool = this.#pool(poolRef.kind, poolRef.id);
        const share = { pool_kind: poolRef.kind, pool_id: poolRef.id, share_id: `${poolRef.kind}:${poolRef.id}#${pool.next + 1}` };
        this.#appendDerived({
          event_id: `${migrationId}:${entitlementId}:migrated`, type: "entitlement_migrated", occurred_at: now(),
          payload: { migration_id: migrationId, entitlement_id: entitlementId, from_flight_version_id: mig.from, to_flight_version_id: mig.to },
          derived: { share },
        });
      } else {
        const liabilityId = `liab:${migrationId}:${entitlementId}`;
        this.#appendDerived({
          event_id: liabilityId, type: "liability_recorded", occurred_at: now(),
          payload: {
            migration_id: migrationId, liability_id: liabilityId, entitlement_id: entitlementId,
            passenger_id: pkg.passenger_id, item_type: ent.item_type,
            reason: "目标航班无仍可兑现的份额或不符合目的地规则",
          },
        });
      }
    }
    this.#appendDerived({ event_id: `${migrationId}:completed`, type: "migration_completed", occurred_at: now(), payload: { migration_id: migrationId } });
  }

  // ---------- 替代方案与复核 ----------

  /** 提出替代方案；高风险食品替换进入待复核，其余立即兑现。 */
  proposeSubstitution(input) {
    const payload = pick(input, ["substitution_id", "liability_id", "replacement_batch_id", "proposer"]);
    requireFields(payload, ["substitution_id", "liability_id", "replacement_batch_id"]);
    requireFields(payload.proposer ?? {}, ["actor_id", "role", "org_id"]);
    if (this.#checkReplay(input.event_id, payload)) return this.state.substitutions.get(payload.substitution_id);
    const liability = this.state.liabilities.get(payload.liability_id);
    if (!liability) throw new Error(`未兑现责任不存在：${payload.liability_id}`);
    if (liability.status !== "pending") throw new Error(`未兑现责任已处理：${liability.status}`);
    const batch = this.state.batches.get(payload.replacement_batch_id);
    if (!batch) throw new Error(`替代批次不存在：${payload.replacement_batch_id}`);
    const requiresApproval = batch.high_risk && FOOD_TYPES.has(batch.item_type);
    this.#appendAndReduce({
      event_id: input.event_id, type: "substitution_proposed", occurred_at: input.occurred_at ?? now(),
      payload, derived: { requires_approval: requiresApproval },
    });
    if (!requiresApproval) this.#applySubstitution(payload.substitution_id);
    return this.state.substitutions.get(payload.substitution_id);
  }

  /** 复核高风险食品替换：须不同角色，且供应方不能批准自身批次。 */
  approveSubstitution(input) {
    const payload = pick(input, ["substitution_id", "approver"]);
    requireFields(payload, ["substitution_id"]);
    requireFields(payload.approver ?? {}, ["actor_id", "role", "org_id"]);
    if (this.#checkReplay(input.event_id, payload)) return this.state.substitutions.get(payload.substitution_id);
    const sub = this.state.substitutions.get(payload.substitution_id);
    if (!sub) throw new Error(`替代方案不存在：${payload.substitution_id}`);
    if (sub.status !== "pending_approval") throw new Error(`替代方案不在待复核状态：${sub.status}`);
    const batch = this.state.batches.get(sub.replacement_batch_id);
    if (payload.approver.role === sub.proposer.role) throw new Error("高风险食品替换须由不同角色复核");
    if (payload.approver.org_id === batch.supplier_id) throw new Error("供应方不能批准自身批次");
    this.#appendAndReduce({ event_id: input.event_id, type: "substitution_approved", occurred_at: input.occurred_at ?? now(), payload });
    this.#applySubstitution(payload.substitution_id);
    return this.state.substitutions.get(payload.substitution_id);
  }

  /** 兑现替代方案：为旅客在替代批次上占用份额并生成已确认权益。 */
  #applySubstitution(substitutionId) {
    const sub = this.state.substitutions.get(substitutionId);
    if (!sub || sub.status !== "approved") return "skipped";
    const liability = this.state.liabilities.get(sub.liability_id);
    const batch = this.state.batches.get(sub.replacement_batch_id);
    const passenger = this.state.passengers.get(liability.passenger_id);
    if (batch.shares.size >= batch.quantity || !allergenSafe(batch, passenger, null)) {
      this.#appendDerived({
        event_id: `${substitutionId}:failed`, type: "substitution_failed", occurred_at: now(),
        payload: { substitution_id: substitutionId, reason: "替代批次无可用份额或与旅客过敏原冲突" },
      });
      return "failed";
    }
    this.#appendDerived({
      event_id: `${substitutionId}:applied`, type: "substitution_applied", occurred_at: now(),
      payload: { substitution_id: substitutionId, liability_id: sub.liability_id },
      derived: {
        entitlement_id: `sub:${substitutionId}`,
        share: { pool_kind: "batch", pool_id: batch.batch_id, share_id: `batch:${batch.batch_id}#${batch.next + 1}` },
      },
    });
    return "applied";
  }

  // ---------- 恢复与查询 ----------

  /** 恢复未完成的迁移与已批准未兑现的补偿；构造时自动执行一次。 */
  #recover() {
    const report = { resumed_migrations: [], applied_substitutions: [], failed_substitutions: [] };
    for (const mig of [...this.state.migrations.values()]) {
      if (mig.status === "in_progress") {
        this.#processMigration(mig.migration_id);
        report.resumed_migrations.push(mig.migration_id);
      }
    }
    for (const sub of [...this.state.substitutions.values()]) {
      if (sub.status === "approved") {
        const result = this.#applySubstitution(sub.substitution_id);
        (result === "applied" ? report.applied_substitutions : report.failed_substitutions).push(sub.substitution_id);
      }
    }
    return report;
  }

  /**
   * 旅客账单：最终可领取项目、每次变更依据、未兑现责任与受影响批次，
   * 而不是只给出当前库存总数。
   */
  passengerStatement(passengerId) {
    const passenger = this.state.passengers.get(String(passengerId));
    if (!passenger) throw new Error(`旅客不存在：${passengerId}`);
    const packages = [...this.state.packages.values()].filter((p) => p.passenger_id === passenger.passenger_id);
    const entitlements = packages.flatMap((p) => p.entitlement_ids.map((id) => this.state.entitlements.get(id)).filter(Boolean));

    const claimable = entitlements
      .filter((e) => e.state === "confirmed")
      .map((e) => ({
        entitlement_id: e.entitlement_id, item_type: e.item_type, activity_kind: e.activity_kind,
        flight_version_id: e.flight_version_id, share: e.share,
      }));

    const changes = {};
    for (const e of entitlements) changes[e.entitlement_id] = this.state.changes.get(e.entitlement_id) ?? [];

    const liabilities = [...this.state.liabilities.values()]
      .filter((l) => l.passenger_id === passenger.passenger_id)
      .map((l) => {
        const sub = l.substitution_id ? this.state.substitutions.get(l.substitution_id) : null;
        return {
          liability_id: l.liability_id, entitlement_id: l.entitlement_id, item_type: l.item_type,
          reason: l.reason, status: l.status, substitution_id: l.substitution_id,
          substitution: sub ? { substitution_id: sub.substitution_id, replacement_batch_id: sub.replacement_batch_id, status: sub.status } : null,
        };
      });

    const affected = new Map();
    const addBatch = (batchId, reason) => {
      if (!batchId) return;
      const entry = affected.get(batchId) ?? { batch_id: batchId, reasons: [] };
      if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
      affected.set(batchId, entry);
    };
    for (const l of liabilities) {
      const orig = this.state.entitlements.get(l.entitlement_id);
      const share = orig?.last_share ?? orig?.share;
      if (share?.pool_kind === "batch") addBatch(share.pool_id, "未兑现责任涉及批次");
      const sub = l.substitution_id ? this.state.substitutions.get(l.substitution_id) : null;
      if (sub) addBatch(sub.replacement_batch_id, "替代方案批次");
    }
    for (const pkg of packages.filter((p) => p.status === "frozen")) {
      for (const eid of pkg.entitlement_ids) {
        const e = this.state.entitlements.get(eid);
        const share = e?.share ?? e?.last_share;
        if (share?.pool_kind === "batch") addBatch(share.pool_id, "关联服务包已冻结");
      }
    }

    return {
      passenger_id: passenger.passenger_id,
      generated_at: now(),
      claimable,
      changes,
      liabilities,
      affected_batches: [...affected.values()],
    };
  }

  // ---------- 内部：事件写入、重放与归约 ----------

  /** 重放检查：相同载荷直接返回现状；载荷冲突则冻结相关服务包并抛错。 */
  #checkReplay(eventId, clientPayload) {
    requireFields({ event_id: eventId }, ["event_id"]);
    const seen = this.ledger.find(eventId);
    if (!seen) return false;
    if (seen.payload_hash === hashPayload(clientPayload)) return true;
    this.#freeze(seen, clientPayload);
    throw new Error(`事件编号冲突：${eventId}，相关服务包已冻结`);
  }

  #appendAndReduce(event) {
    const result = this.ledger.append(event);
    if (result.status === "applied") this.#reduce(result.event);
    else if (result.status === "conflict") {
      this.#freeze(result.event, event.payload);
      throw new Error(`事件编号冲突：${event.event_id}，相关服务包已冻结`);
    }
    return result;
  }

  #appendDerived(event) {
    const result = this.ledger.append(event);
    if (result.status === "applied") this.#reduce(result.event);
    return result;
  }

  /** 事件编号冲突时，冻结双方载荷引用到的全部服务包。 */
  #freeze(storedEvent, incomingPayload) {
    const ids = new Set();
    for (const p of [storedEvent.payload ?? {}, incomingPayload ?? {}]) {
      if (p.package_id && this.state.packages.has(p.package_id)) ids.add(p.package_id);
      if (p.entitlement_id) {
        const ent = this.state.entitlements.get(p.entitlement_id);
        if (ent) ids.add(ent.package_id);
      }
      if (p.flight_version_id) {
        for (const [id, pkg] of this.state.packages) if (pkg.flight_version_id === p.flight_version_id) ids.add(id);
      }
      if (p.passenger_id) {
        for (const [id, pkg] of this.state.packages) if (pkg.passenger_id === p.passenger_id) ids.add(id);
      }
      if (p.liability_id) {
        const liability = this.state.liabilities.get(p.liability_id);
        const ent = liability && this.state.entitlements.get(liability.entitlement_id);
        if (ent) ids.add(ent.package_id);
      }
    }
    if (!ids.size) return;
    this.#appendDerived({
      event_id: `freeze:${storedEvent.event_id}`, type: "packages_frozen", occurred_at: now(),
      payload: { cause_event_id: storedEvent.event_id, package_ids: [...ids] },
    });
  }

  #requirePackage(packageId) {
    const pkg = this.state.packages.get(packageId);
    if (!pkg) throw new Error(`服务包不存在：${packageId}`);
    if (pkg.status === "frozen") throw new Error(`服务包已冻结：${packageId}`);
    return pkg;
  }

  #requireEntitlement(entitlementId) {
    const ent = this.state.entitlements.get(entitlementId);
    if (!ent) throw new Error(`权益不存在：${entitlementId}`);
    if (ent.state === "frozen") throw new Error(`权益所在服务包已冻结：${entitlementId}`);
    return ent;
  }

  #pool(kind, id) {
    const maps = { station: this.state.stations, batch: this.state.batches, staff: this.state.staff };
    const pool = maps[kind]?.get(id);
    if (!pool) throw new Error(`资源池不存在：${kind}:${id}`);
    return pool;
  }

  /** 目的地规则：被禁的权益类型不得兑现。 */
  #destinationAllows(flight, ent) {
    return !(flight.rules?.disallowed_item_types ?? []).includes(ent.item_type);
  }

  /** 在指定航班版本上为权益解析可用资源池；无可用份额返回 null。 */
  #resolvePool(flightVersionId, ent, passenger) {
    const flight = this.state.flights.get(flightVersionId);
    if (!flight) return null;
    if (ent.item_type === "lounge") {
      if (!flight.station_id) return null;
      const station = this.state.stations.get(flight.station_id);
      return station && station.shares.size < station.capacity ? { kind: "station", id: station.station_id } : null;
    }
    if (FOOD_TYPES.has(ent.item_type)) {
      for (const loading of this.state.loadings.filter((l) => l.flight_version_id === flightVersionId)) {
        const batch = this.state.batches.get(loading.batch_id);
        if (!batch || batch.item_type !== ent.item_type) continue;
        if (batch.shares.size >= batch.quantity) continue;
        if (!allergenSafe(batch, passenger, flight)) continue;
        return { kind: "batch", id: batch.batch_id };
      }
      return null;
    }
    if (ent.item_type === "activity") {
      for (const assignment of this.state.assignments.filter((a) => a.flight_version_id === flightVersionId)) {
        const staff = this.state.staff.get(assignment.staff_id);
        if (!staff || staff.shares.size >= staff.capacity) continue;
        if (ent.activity_kind && !staff.qualifications.includes(ent.activity_kind)) continue;
        return { kind: "staff", id: staff.staff_id };
      }
    }
    return null;
  }

  #recordChange(entitlementId, event, summary) {
    const list = this.state.changes.get(entitlementId) ?? [];
    list.push({ seq: event.seq, event_id: event.event_id, type: event.type, summary });
    this.state.changes.set(entitlementId, list);
  }

  #releaseShare(share) {
    if (!share) return;
    this.#pool(share.pool_kind, share.pool_id).shares.delete(share.share_id);
  }

  #occupyShare(share) {
    const pool = this.#pool(share.pool_kind, share.pool_id);
    pool.next += 1;
    pool.shares.add(share.share_id);
  }

  #reduce(event) {
    const p = event.payload ?? {};
    const d = event.derived ?? {};
    switch (event.type) {
      case "flight_version_registered":
        this.state.flights.set(p.flight_version_id, {
          flight_version_id: p.flight_version_id, flight_id: p.flight_id, version: p.version ?? 1,
          destination: p.destination, station_id: p.station_id ?? null,
          rules: { disallowed_item_types: [], allergen_declaration_required: false, ...(p.rules ?? {}) },
        });
        break;
      case "station_registered":
        this.state.stations.set(p.station_id, { station_id: p.station_id, name: p.name ?? null, capacity: p.capacity, shares: new Set(), next: 0 });
        break;
      case "batch_registered":
        this.state.batches.set(p.batch_id, {
          batch_id: p.batch_id, supplier_id: p.supplier_id, item_type: p.item_type,
          high_risk: Boolean(p.high_risk), allergens: p.allergens ?? null,
          quantity: p.quantity, loaded: 0, shares: new Set(), next: 0,
        });
        break;
      case "allergens_declared":
        this.state.batches.get(p.batch_id).allergens = [...p.allergens];
        break;
      case "staff_registered":
        this.state.staff.set(p.staff_id, { staff_id: p.staff_id, qualifications: [...p.qualifications], capacity: p.capacity, shares: new Set(), next: 0 });
        break;
      case "staff_assigned":
        this.state.assignments.push({ flight_version_id: p.flight_version_id, staff_id: p.staff_id });
        break;
      case "handover_recorded":
        this.state.loadings.push({ handover_id: p.handover_id, flight_version_id: p.flight_version_id, batch_id: p.batch_id, quantity: p.quantity });
        this.state.batches.get(p.batch_id).loaded += p.quantity;
        break;
      case "passenger_registered":
        this.state.passengers.set(p.passenger_id, { passenger_id: p.passenger_id, allergens: [...(p.allergens ?? [])] });
        break;
      case "package_registered":
        this.state.packages.set(p.package_id, { package_id: p.package_id, passenger_id: p.passenger_id, flight_version_id: p.flight_version_id, status: "active", entitlement_ids: [] });
        break;
      case "entitlement_reserved": {
        const pkg = this.state.packages.get(p.package_id);
        const ent = {
          entitlement_id: p.entitlement_id, package_id: p.package_id, item_type: p.item_type,
          activity_kind: p.activity_kind ?? null, state: "reserved",
          flight_version_id: d.flight_version_id, share: d.share, last_share: null, redeemed_at: null,
        };
        this.state.entitlements.set(p.entitlement_id, ent);
        pkg.entitlement_ids.push(p.entitlement_id);
        this.#occupyShare(d.share);
        this.#recordChange(p.entitlement_id, event, `在 ${d.flight_version_id} 预留 ${p.item_type}，占用份额 ${d.share.share_id}`);
        break;
      }
      case "entitlement_confirmed": {
        const ent = this.state.entitlements.get(p.entitlement_id);
        ent.state = "confirmed";
        this.#recordChange(p.entitlement_id, event, `确认权益，继续占用份额 ${ent.share.share_id}`);
        break;
      }
      case "entitlement_redeemed": {
        const ent = this.state.entitlements.get(p.entitlement_id);
        ent.state = "redeemed";
        ent.redeemed_at = event.occurred_at;
        this.#recordChange(p.entitlement_id, event, `核销体验，份额 ${ent.share.share_id} 形成事实记录`);
        break;
      }
      case "migration_started":
        this.state.migrations.set(p.migration_id, {
          migration_id: p.migration_id, from: p.from_flight_version_id, to: p.to_flight_version_id,
          queue: [...(d.entitlement_ids ?? [])], status: "in_progress",
        });
        break;
      case "migration_item_skipped": {
        const mig = this.state.migrations.get(p.migration_id);
        if (mig) mig.queue = mig.queue.filter((id) => id !== p.entitlement_id);
        break;
      }
      case "entitlement_migrated": {
        const ent = this.state.entitlements.get(p.entitlement_id);
        const oldShare = ent.share;
        this.#releaseShare(oldShare);
        ent.share = d.share;
        ent.flight_version_id = p.to_flight_version_id;
        this.#occupyShare(d.share);
        const mig = this.state.migrations.get(p.migration_id);
        if (mig) mig.queue = mig.queue.filter((id) => id !== p.entitlement_id);
        this.#recordChange(p.entitlement_id, event, `航班拆并：${p.from_flight_version_id} → ${p.to_flight_version_id}，份额 ${oldShare.share_id} → ${d.share.share_id}`);
        break;
      }
      case "liability_recorded": {
        this.state.liabilities.set(p.liability_id, {
          liability_id: p.liability_id, passenger_id: p.passenger_id, entitlement_id: p.entitlement_id,
          item_type: p.item_type, reason: p.reason, status: "pending", substitution_id: null,
        });
        const ent = this.state.entitlements.get(p.entitlement_id);
        this.#releaseShare(ent.share);
        ent.last_share = ent.share;
        ent.share = null;
        ent.state = "void";
        const mig = this.state.migrations.get(p.migration_id);
        if (mig) mig.queue = mig.queue.filter((id) => id !== p.entitlement_id);
        this.#recordChange(p.entitlement_id, event, `无法迁移：${p.reason}，登记未兑现责任 ${p.liability_id}`);
        break;
      }
      case "migration_completed": {
        const mig = this.state.migrations.get(p.migration_id);
        if (mig) mig.status = "completed";
        break;
      }
      case "packages_frozen":
        for (const packageId of p.package_ids) {
          const pkg = this.state.packages.get(packageId);
          if (!pkg) continue;
          pkg.status = "frozen";
          for (const eid of pkg.entitlement_ids) {
            const ent = this.state.entitlements.get(eid);
            if (ent && MIGRATABLE_STATES.has(ent.state)) {
              ent.state = "frozen";
              this.#recordChange(eid, event, `事件编号 ${p.cause_event_id} 载荷冲突，服务包冻结，权益暂停`);
            }
          }
        }
        break;
      case "substitution_proposed": {
        this.state.substitutions.set(p.substitution_id, {
          substitution_id: p.substitution_id, liability_id: p.liability_id,
          replacement_batch_id: p.replacement_batch_id, proposer: p.proposer,
          requires_approval: Boolean(d.requires_approval),
          status: d.requires_approval ? "pending_approval" : "approved",
          approver: null, failure: null,
        });
        const liability = this.state.liabilities.get(p.liability_id);
        if (liability) liability.substitution_id = p.substitution_id;
        break;
      }
      case "substitution_approved": {
        const sub = this.state.substitutions.get(p.substitution_id);
        sub.status = "approved";
        sub.approver = p.approver;
        break;
      }
      case "substitution_applied": {
        const sub = this.state.substitutions.get(p.substitution_id);
        const liability = this.state.liabilities.get(p.liability_id);
        const orig = this.state.entitlements.get(liability.entitlement_id);
        const pkg = this.state.packages.get(orig.package_id);
        const batch = this.state.batches.get(sub.replacement_batch_id);
        const ent = {
          entitlement_id: d.entitlement_id, package_id: pkg.package_id, item_type: batch.item_type,
          activity_kind: null, state: "confirmed", flight_version_id: pkg.flight_version_id,
          share: d.share, last_share: null, redeemed_at: null,
        };
        this.state.entitlements.set(d.entitlement_id, ent);
        pkg.entitlement_ids.push(d.entitlement_id);
        this.#occupyShare(d.share);
        liability.status = "compensated";
        sub.status = "applied";
        this.#recordChange(d.entitlement_id, event, `替代方案 ${p.substitution_id} 兑现，占用份额 ${d.share.share_id}`);
        this.#recordChange(liability.entitlement_id, event, `原权益由替代方案 ${p.substitution_id} 补偿`);
        break;
      }
      case "substitution_failed": {
        const sub = this.state.substitutions.get(p.substitution_id);
        sub.status = "failed";
        sub.failure = p.reason;
        break;
      }
      default:
        break;
    }
  }
}
