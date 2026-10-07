import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchedulingService } from "../src/scheduling.js";
import { EventLedger } from "../src/ledger.js";

/** 两个航班版本的基础场景：FV1 资源齐全，FV2 资源有限。 */
function baseService() {
  const s = new SchedulingService();
  s.registerStation({ event_id: "e-st1", station_id: "ST1", capacity: 2 });
  s.registerStation({ event_id: "e-st2", station_id: "ST2", capacity: 1 });
  s.registerBatch({ event_id: "e-b1", batch_id: "B1", supplier_id: "SUP1", item_type: "meal", quantity: 3, allergens: [] });
  s.registerBatch({ event_id: "e-b2", batch_id: "B2", supplier_id: "SUP2", item_type: "meal", quantity: 1, allergens: [] });
  s.registerBatch({ event_id: "e-b3", batch_id: "B3", supplier_id: "SUP3", item_type: "meal", quantity: 1, high_risk: true, allergens: [] });
  s.registerBatch({ event_id: "e-b4", batch_id: "B4", supplier_id: "SUP1", item_type: "meal", quantity: 1, allergens: ["花生"] });
  s.registerStaff({ event_id: "e-sf1", staff_id: "SF1", qualifications: ["非遗演示"], capacity: 1 });
  s.registerFlightVersion({ event_id: "e-f1", flight_version_id: "FV1", flight_id: "CZ100", version: 1, destination: "PEK", station_id: "ST1" });
  s.registerFlightVersion({ event_id: "e-f2", flight_version_id: "FV2", flight_id: "CZ100", version: 2, destination: "PEK", station_id: "ST2" });
  s.recordHandover({ event_id: "e-h1", handover_id: "H1", flight_version_id: "FV1", batch_id: "B1", quantity: 3 });
  s.recordHandover({ event_id: "e-h2", handover_id: "H2", flight_version_id: "FV2", batch_id: "B2", quantity: 1 });
  s.assignStaff({ event_id: "e-a1", flight_version_id: "FV1", staff_id: "SF1" });
  s.registerPassenger({ event_id: "e-p1", passenger_id: "P1", allergens: [] });
  s.registerPassenger({ event_id: "e-p2", passenger_id: "P2", allergens: ["花生"] });
  s.registerPackage({ event_id: "e-pk1", package_id: "PK1", passenger_id: "P1", flight_version_id: "FV1" });
  s.registerPackage({ event_id: "e-pk2", package_id: "PK2", passenger_id: "P2", flight_version_id: "FV1" });
  return s;
}

test("预留到确认持有唯一份额，容量耗尽即拒绝", () => {
  const s = baseService();
  const e1 = s.reserveEntitlement({ event_id: "r1", entitlement_id: "E1", package_id: "PK1", item_type: "lounge" });
  s.reserveEntitlement({ event_id: "r2", entitlement_id: "E2", package_id: "PK2", item_type: "lounge" });
  assert.equal(s.state.stations.get("ST1").shares.size, 2);
  s.registerPackage({ event_id: "e-pk3", package_id: "PK3", passenger_id: "P1", flight_version_id: "FV1" });
  assert.throws(() => s.reserveEntitlement({ event_id: "r3", entitlement_id: "E3", package_id: "PK3", item_type: "lounge" }), /无可用份额/);
  s.confirmEntitlement({ event_id: "c1", entitlement_id: "E1" });
  // 确认不二次占用：份额不变
  assert.equal(s.state.stations.get("ST1").shares.size, 2);
  assert.equal(s.state.entitlements.get("E1").share.share_id, e1.share.share_id);
});

test("含过敏原批次不会对过敏旅客放份额", () => {
  const s = baseService();
  s.recordHandover({ event_id: "e-h4", handover_id: "H4", flight_version_id: "FV1", batch_id: "B4", quantity: 1 });
  // P2 对花生过敏：B1 无花生可兑现
  const e = s.reserveEntitlement({ event_id: "r1", entitlement_id: "E1", package_id: "PK2", item_type: "meal" });
  assert.equal(e.share.pool_id, "B1");
});

test("同一运行事件重放不二次占用", () => {
  const s = baseService();
  const cmd = { event_id: "r1", entitlement_id: "E1", package_id: "PK1", item_type: "lounge" };
  s.reserveEntitlement(cmd);
  s.reserveEntitlement(cmd);
  s.confirmEntitlement({ event_id: "c1", entitlement_id: "E1" });
  s.confirmEntitlement({ event_id: "c1", entitlement_id: "E1" });
  assert.equal(s.state.stations.get("ST1").shares.size, 1);
  assert.equal(s.state.entitlements.get("E1").state, "confirmed");
});

test("编号相同载荷不同则冻结相关服务包", () => {
  const s = baseService();
  s.reserveEntitlement({ event_id: "r1", entitlement_id: "E1", package_id: "PK1", item_type: "lounge" });
  assert.throws(
    () => s.reserveEntitlement({ event_id: "r1", entitlement_id: "E9", package_id: "PK1", item_type: "meal" }),
    /冲突.*冻结/,
  );
  assert.equal(s.state.packages.get("PK1").status, "frozen");
  assert.equal(s.state.entitlements.get("E1").state, "frozen");
  assert.throws(() => s.confirmEntitlement({ event_id: "c1", entitlement_id: "E1" }), /冻结/);
  // 冻结事实已入账，可被查询
  const frozen = s.ledger.all().find((e) => e.type === "packages_frozen");
  assert.deepEqual(frozen.payload.package_ids, ["PK1"]);
});

test("航班拆并：可兑现的迁移、已核销的保持原事实、不可兑现的登记责任", () => {
  const s = baseService();
  // PK1：休息室确认、餐食确认并核销一份、再确认一份
  s.reserveEntitlement({ event_id: "r1", entitlement_id: "E1", package_id: "PK1", item_type: "lounge" });
  s.confirmEntitlement({ event_id: "c1", entitlement_id: "E1" });
  s.reserveEntitlement({ event_id: "r2", entitlement_id: "E2", package_id: "PK1", item_type: "meal" });
  s.confirmEntitlement({ event_id: "c2", entitlement_id: "E2" });
  s.reserveEntitlement({ event_id: "r3", entitlement_id: "E3", package_id: "PK1", item_type: "meal" });
  s.confirmEntitlement({ event_id: "c3", entitlement_id: "E3" });
  s.redeemEntitlement({ event_id: "x3", entitlement_id: "E3" });
  // PK2：非遗演示（FV2 无演示人员）
  s.reserveEntitlement({ event_id: "r4", entitlement_id: "E4", package_id: "PK2", item_type: "activity", activity_kind: "非遗演示" });
  s.confirmEntitlement({ event_id: "c4", entitlement_id: "E4" });

  const mig = s.migrateFlight({ event_id: "m1", migration_id: "M1", from_flight_version_id: "FV1", to_flight_version_id: "FV2" });
  assert.equal(mig.status, "completed");

  // 可兑现：休息室迁到 ST2，餐食迁到 B2
  assert.equal(s.state.entitlements.get("E1").flight_version_id, "FV2");
  assert.equal(s.state.entitlements.get("E1").share.pool_id, "ST2");
  assert.equal(s.state.entitlements.get("E2").share.pool_id, "B2");
  // 已核销：保持原事实
  const e3 = s.state.entitlements.get("E3");
  assert.equal(e3.state, "redeemed");
  assert.equal(e3.flight_version_id, "FV1");
  assert.ok(e3.redeemed_at);
  // 不可兑现：非遗演示在 FV2 无资质人员，登记责任并释放原份额
  assert.equal(s.state.entitlements.get("E4").state, "void");
  assert.equal(s.state.staff.get("SF1").shares.size, 0);
  const liabilities = [...s.state.liabilities.values()];
  assert.equal(liabilities.length, 1);
  assert.equal(liabilities[0].entitlement_id, "E4");
  // 迁移释放源份额：ST1 只剩已核销占用之外的空位
  assert.equal(s.state.stations.get("ST1").shares.size, 0);
});

test("迁移重放不重复迁移", () => {
  const s = baseService();
  s.reserveEntitlement({ event_id: "r1", entitlement_id: "E1", package_id: "PK1", item_type: "meal" });
  s.confirmEntitlement({ event_id: "c1", entitlement_id: "E1" });
  const cmd = { event_id: "m1", migration_id: "M1", from_flight_version_id: "FV1", to_flight_version_id: "FV2" };
  s.migrateFlight(cmd);
  s.migrateFlight(cmd);
  assert.equal(s.state.batches.get("B2").shares.size, 1);
  assert.equal(s.state.batches.get("B1").shares.size, 0);
});

test("高风险食品替换须不同角色复核，供应方不能批准自身批次", () => {
  const s = baseService();
  s.reserveEntitlement({ event_id: "r1", entitlement_id: "E1", package_id: "PK2", item_type: "activity", activity_kind: "非遗演示" });
  s.confirmEntitlement({ event_id: "c1", entitlement_id: "E1" });
  s.migrateFlight({ event_id: "m1", migration_id: "M1", from_flight_version_id: "FV1", to_flight_version_id: "FV2" });
  const liabilityId = "liab:M1:E1";

  const sub = s.proposeSubstitution({
    event_id: "s1", substitution_id: "SUB1", liability_id: liabilityId, replacement_batch_id: "B3",
    proposer: { actor_id: "U1", role: "乘务调度", org_id: "AIRLINE" },
  });
  assert.equal(sub.status, "pending_approval");

  assert.throws(
    () => s.approveSubstitution({ event_id: "s2", substitution_id: "SUB1", approver: { actor_id: "U2", role: "乘务调度", org_id: "AIRLINE" } }),
    /不同角色/,
  );
  assert.throws(
    () => s.approveSubstitution({ event_id: "s3", substitution_id: "SUB1", approver: { actor_id: "U3", role: "食品安全员", org_id: "SUP3" } }),
    /供应方不能批准自身批次/,
  );

  const approved = s.approveSubstitution({ event_id: "s4", substitution_id: "SUB1", approver: { actor_id: "U4", role: "食品安全员", org_id: "AIRLINE" } });
  assert.equal(approved.status, "applied");
  assert.equal(s.state.liabilities.get(liabilityId).status, "compensated");
  const compensation = s.state.entitlements.get("sub:SUB1");
  assert.equal(compensation.state, "confirmed");
  assert.equal(compensation.share.pool_id, "B3");
  assert.equal(s.state.batches.get("B3").shares.size, 1);
});

test("非高风险替换无需复核，提出即兑现", () => {
  const s = baseService();
  s.reserveEntitlement({ event_id: "r1", entitlement_id: "E1", package_id: "PK1", item_type: "activity", activity_kind: "非遗演示" });
  s.confirmEntitlement({ event_id: "c1", entitlement_id: "E1" });
  s.migrateFlight({ event_id: "m1", migration_id: "M1", from_flight_version_id: "FV1", to_flight_version_id: "FV2" });
  const sub = s.proposeSubstitution({
    event_id: "s1", substitution_id: "SUB1", liability_id: "liab:M1:E1", replacement_batch_id: "B1",
    proposer: { actor_id: "U1", role: "乘务调度", org_id: "AIRLINE" },
  });
  assert.equal(sub.status, "applied");
  assert.equal(s.state.liabilities.get("liab:M1:E1").status, "compensated");
});

test("进程重启后从事件账恢复未完成的迁移与补偿", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const file = join(dir, "events.jsonl");

  // 进程 A：完成基础登记与一项确认权益
  const a = new SchedulingService(new EventLedger(file));
  a.registerStation({ event_id: "e-st2", station_id: "ST2", capacity: 1 });
  a.registerBatch({ event_id: "e-b1", batch_id: "B1", supplier_id: "SUP1", item_type: "meal", quantity: 1, allergens: [] });
  a.registerBatch({ event_id: "e-b2", batch_id: "B2", supplier_id: "SUP2", item_type: "meal", quantity: 1, allergens: [] });
  a.registerBatch({ event_id: "e-b3", batch_id: "B3", supplier_id: "SUP3", item_type: "meal", quantity: 1, high_risk: true, allergens: [] });
  a.registerFlightVersion({ event_id: "e-f1", flight_version_id: "FV1", flight_id: "CZ100", version: 1, destination: "PEK" });
  a.registerFlightVersion({ event_id: "e-f2", flight_version_id: "FV2", flight_id: "CZ100", version: 2, destination: "PEK" });
  a.registerFlightVersion({ event_id: "e-f3", flight_version_id: "FV3", flight_id: "CZ100", version: 3, destination: "PEK" });
  a.recordHandover({ event_id: "e-h1", handover_id: "H1", flight_version_id: "FV1", batch_id: "B1", quantity: 1 });
  a.recordHandover({ event_id: "e-h2", handover_id: "H2", flight_version_id: "FV2", batch_id: "B2", quantity: 1 });
  a.registerPassenger({ event_id: "e-p1", passenger_id: "P1", allergens: [] });
  a.registerPackage({ event_id: "e-pk1", package_id: "PK1", passenger_id: "P1", flight_version_id: "FV1" });
  a.reserveEntitlement({ event_id: "r1", entitlement_id: "E1", package_id: "PK1", item_type: "meal" });
  a.confirmEntitlement({ event_id: "c1", entitlement_id: "E1" });

  // 模拟崩溃：migration_started 已落账，但逐项迁移尚未执行
  a.ledger.append({
    event_id: "m1", type: "migration_started", occurred_at: new Date().toISOString(),
    payload: { migration_id: "M1", from_flight_version_id: "FV1", to_flight_version_id: "FV2" },
    derived: { entitlement_ids: ["E1"] },
  });

  // 进程 B：重启后从事件账恢复，迁移被续跑完成
  const b = new SchedulingService(new EventLedger(file));
  assert.deepEqual(b.recovery.resumed_migrations, ["M1"]);
  assert.equal(b.state.migrations.get("M1").status, "completed");
  assert.equal(b.state.entitlements.get("E1").flight_version_id, "FV2");
  assert.equal(b.state.entitlements.get("E1").share.pool_id, "B2");
  // 份额不重复占用：B1 已释放，B2 恰好一份
  assert.equal(b.state.batches.get("B1").shares.size, 0);
  assert.equal(b.state.batches.get("B2").shares.size, 1);

  // 进程 B 继续：迁往无批次装载的 FV3 产生责任，并提出高风险替换
  b.migrateFlight({ event_id: "m2", migration_id: "M2", from_flight_version_id: "FV2", to_flight_version_id: "FV3" });
  assert.equal(b.state.liabilities.get("liab:M2:E1").status, "pending");
  b.proposeSubstitution({
    event_id: "s1", substitution_id: "SUB1", liability_id: "liab:M2:E1", replacement_batch_id: "B3",
    proposer: { actor_id: "U1", role: "乘务调度", org_id: "AIRLINE" },
  });

  // 模拟崩溃：复核通过已落账，兑现尚未执行
  b.ledger.append({
    event_id: "s2", type: "substitution_approved", occurred_at: new Date().toISOString(),
    payload: { substitution_id: "SUB1", approver: { actor_id: "U2", role: "食品安全员", org_id: "AIRLINE" } },
  });

  // 进程 C：恢复后补偿被兑现，且只占用一次
  const c = new SchedulingService(new EventLedger(file));
  assert.deepEqual(c.recovery.applied_substitutions, ["SUB1"]);
  assert.equal(c.state.liabilities.get("liab:M2:E1").status, "compensated");
  assert.equal(c.state.entitlements.get("sub:SUB1").state, "confirmed");
  assert.equal(c.state.batches.get("B3").shares.size, 1);
});

test("旅客账单返回可领取项目、变更依据、未兑现责任与受影响批次", () => {
  const s = baseService();
  s.reserveEntitlement({ event_id: "r1", entitlement_id: "E1", package_id: "PK1", item_type: "lounge" });
  s.confirmEntitlement({ event_id: "c1", entitlement_id: "E1" });
  s.reserveEntitlement({ event_id: "r2", entitlement_id: "E2", package_id: "PK1", item_type: "meal" });
  s.confirmEntitlement({ event_id: "c2", entitlement_id: "E2" });
  s.reserveEntitlement({ event_id: "r3", entitlement_id: "E3", package_id: "PK2", item_type: "meal" });
  s.confirmEntitlement({ event_id: "c3", entitlement_id: "E3" });
  // FV2 只有一份 B2：E2 迁走，E3 成为责任；再用 B3 高风险替换补偿
  s.migrateFlight({ event_id: "m1", migration_id: "M1", from_flight_version_id: "FV1", to_flight_version_id: "FV2" });
  s.proposeSubstitution({
    event_id: "s1", substitution_id: "SUB1", liability_id: "liab:M1:E3", replacement_batch_id: "B3",
    proposer: { actor_id: "U1", role: "乘务调度", org_id: "AIRLINE" },
  });
  s.approveSubstitution({ event_id: "s2", substitution_id: "SUB1", approver: { actor_id: "U2", role: "食品安全员", org_id: "AIRLINE" } });

  const st1 = s.passengerStatement("P1");
  assert.deepEqual(st1.claimable.map((e) => e.entitlement_id).sort(), ["E1", "E2"]);
  assert.ok(st1.changes.E1.some((c) => c.type === "entitlement_migrated"));
  assert.ok(st1.changes.E2.every((c) => c.event_id && c.summary));
  assert.equal(st1.liabilities.length, 0);

  const st2 = s.passengerStatement("P2");
  // P2 原权益失效，替代补偿可领取
  assert.deepEqual(st2.claimable.map((e) => e.entitlement_id), ["sub:SUB1"]);
  assert.equal(st2.liabilities.length, 1);
  assert.equal(st2.liabilities[0].status, "compensated");
  assert.equal(st2.liabilities[0].substitution.replacement_batch_id, "B3");
  const batchIds = st2.affected_batches.map((b) => b.batch_id).sort();
  assert.deepEqual(batchIds, ["B1", "B3"]);
  const b1 = st2.affected_batches.find((b) => b.batch_id === "B1");
  assert.ok(b1.reasons.includes("未兑现责任涉及批次"));
});

test("目的地规则禁止的权益类型不得迁移", () => {
  const s = baseService();
  s.registerFlightVersion({
    event_id: "e-f9", flight_version_id: "FV9", flight_id: "CZ100", version: 9,
    destination: "HKG", station_id: "ST2", rules: { disallowed_item_types: ["activity"] },
  });
  s.assignStaff({ event_id: "e-a9", flight_version_id: "FV9", staff_id: "SF1" });
  s.reserveEntitlement({ event_id: "r1", entitlement_id: "E1", package_id: "PK1", item_type: "activity", activity_kind: "非遗演示" });
  s.confirmEntitlement({ event_id: "c1", entitlement_id: "E1" });
  s.migrateFlight({ event_id: "m1", migration_id: "M1", from_flight_version_id: "FV1", to_flight_version_id: "FV9" });
  assert.equal(s.state.entitlements.get("E1").state, "void");
  assert.equal(s.state.liabilities.get("liab:M1:E1").status, "pending");
});

test("装载交接不得超过批次总量", () => {
  const s = baseService();
  assert.throws(
    () => s.recordHandover({ event_id: "e-h9", handover_id: "H9", flight_version_id: "FV1", batch_id: "B2", quantity: 2 }),
    /超过批次总量/,
  );
});
