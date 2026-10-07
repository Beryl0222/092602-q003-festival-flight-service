import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Service } from "../src/service.js";
import { EventLedger } from "../src/ledger.js";

/** 基础运行环境：两名旅客、两个航班、休息室、两个批次、一名非遗人员。 */
function worldEvents() {
  return [
    { event_id: "pax-1", type: "passenger_registered", payload: { passenger_id: "P1", allergens: ["花生"] } },
    { event_id: "pax-2", type: "passenger_registered", payload: { passenger_id: "P2", allergens: [] } },
    { event_id: "pax-3", type: "passenger_registered", payload: { passenger_id: "P3", allergens: [] } },
    { event_id: "flt-100", type: "flight_registered", payload: { flight_id: "CZ100", version: 1, origin: "CAN", destination: "PEK", aircraft: "A330" } },
    { event_id: "flt-200", type: "flight_registered", payload: { flight_id: "CZ200", version: 1, origin: "CAN", destination: "PEK", aircraft: "B787" } },
    { event_id: "stn-1", type: "station_registered", payload: { station_id: "L-CAN-01", airport: "CAN", capacity: 2 } },
    { event_id: "bat-1", type: "batch_registered", payload: { batch_id: "B1", supplier_id: "SUP-A", allergens: ["花生"], high_risk: true, quantity: 1 } },
    { event_id: "bat-2", type: "batch_registered", payload: { batch_id: "B2", supplier_id: "SUP-B", allergens: [], high_risk: false, quantity: 10 } },
    { event_id: "stf-1", type: "staff_registered", payload: { staff_id: "ART-01", qualifications: ["heritage_demo"], sessions: 1 } },
    { event_id: "ldg-200-b2", type: "loading_recorded", payload: { flight_id: "CZ200", version: 1, batch_id: "B2", quantity: 10 } },
  ];
}

function makeService() {
  const service = new Service();
  for (const event of worldEvents()) service.applyEvent(event);
  return service;
}

const MERGE = { event_id: "merge-1", type: "flights_merged", payload: { merge_id: "MG1", source_flight_ids: ["CZ100"], target_flight_id: "CZ200" } };

function reserveFood(service, id, passenger, batch = "B2", flight = "CZ100") {
  return service.applyEvent({
    event_id: `ent-${id}`, type: "entitlement_reserved",
    payload: { entitlement_id: id, passenger_id: passenger, flight_id: flight, kind: "festival_food", batch_id: batch },
  });
}

test("预留占用唯一份额，容量耗尽被拒绝", () => {
  const service = makeService();
  reserveFood(service, "E1", "P2", "B1"); // B1 容量 1
  assert.throws(() => reserveFood(service, "E2", "P3", "B1"), /可用份额不足/);
  // 非遗人员场次 1
  service.applyEvent({ event_id: "ent-d1", type: "entitlement_reserved", payload: { entitlement_id: "D1", passenger_id: "P2", flight_id: "CZ100", kind: "heritage_demo", staff_id: "ART-01" } });
  assert.throws(
    () => service.applyEvent({ event_id: "ent-d2", type: "entitlement_reserved", payload: { entitlement_id: "D2", passenger_id: "P3", flight_id: "CZ100", kind: "heritage_demo", staff_id: "ART-01" } }),
    /可用份额不足/,
  );
});

test("同一运行事件重放不二次占用", () => {
  const service = makeService();
  const event = { event_id: "ent-l1", type: "entitlement_reserved", payload: { entitlement_id: "L1", passenger_id: "P2", flight_id: "CZ100", kind: "lounge_access", station_id: "L-CAN-01" } };
  assert.equal(service.applyEvent(event).status, "applied");
  assert.equal(service.applyEvent(event).status, "duplicate"); // 重放
  assert.equal(service.applyEvent(event).status, "duplicate");
  // 休息室容量 2：若重放二次占用，下一条就会失败
  service.applyEvent({ event_id: "ent-l2", type: "entitlement_reserved", payload: { entitlement_id: "L2", passenger_id: "P3", flight_id: "CZ100", kind: "lounge_access", station_id: "L-CAN-01" } });
  assert.throws(
    () => service.applyEvent({ event_id: "ent-l3", type: "entitlement_reserved", payload: { entitlement_id: "L3", passenger_id: "P1", flight_id: "CZ100", kind: "lounge_access", station_id: "L-CAN-01" } }),
    /可用份额不足/,
  );
});

test("确认与核销状态机，越界流转被拒绝", () => {
  const service = makeService();
  reserveFood(service, "E1", "P2");
  service.applyEvent({ event_id: "c1", type: "entitlement_confirmed", payload: { entitlement_id: "E1" } });
  assert.throws(
    () => service.applyEvent({ event_id: "c2", type: "entitlement_confirmed", payload: { entitlement_id: "E1" } }),
    /当前状态不可确认/,
  );
  service.applyEvent({ event_id: "r1", type: "entitlement_redeemed", payload: { entitlement_id: "E1" } });
  assert.throws(
    () => service.applyEvent({ event_id: "r2", type: "entitlement_redeemed", payload: { entitlement_id: "E1" } }),
    /仅已确认权益可核销/,
  );
  assert.throws(
    () => service.applyEvent({ event_id: "x1", type: "entitlement_released", payload: { entitlement_id: "E1" } }),
    /当前状态不可释放/,
  );
});

test("已核销的体验在航班合并中保持原事实", () => {
  const service = makeService();
  reserveFood(service, "E1", "P2");
  service.applyEvent({ event_id: "c1", type: "entitlement_confirmed", payload: { entitlement_id: "E1" } });
  service.applyEvent({ event_id: "r1", type: "entitlement_redeemed", payload: { entitlement_id: "E1" } });
  service.applyEvent(MERGE);
  const statement = service.passengerStatement("P2");
  assert.equal(statement.redeemed.length, 1);
  assert.equal(statement.redeemed[0].flight_id, "CZ100"); // 不迁移
  assert.equal(statement.claimable.length, 0);
  assert.ok(statement.changes.some((c) => c.basis.includes("核销")));
});

test("编号相同而载荷不同则冻结相关服务包，解冻后方可继续", () => {
  const service = makeService();
  const original = { event_id: "ent-x", type: "entitlement_reserved", payload: { entitlement_id: "E-X", passenger_id: "P2", flight_id: "CZ100", kind: "lounge_access", station_id: "L-CAN-01" } };
  service.applyEvent(original);
  const conflict = service.applyEvent({ ...original, payload: { ...original.payload, passenger_id: "P1" } });
  assert.equal(conflict.status, "conflict_frozen");
  assert.deepEqual(conflict.frozen, ["E-X"]);
  assert.throws(
    () => service.applyEvent({ event_id: "c-x", type: "entitlement_confirmed", payload: { entitlement_id: "E-X" } }),
    /已冻结/,
  );
  assert.equal(service.passengerStatement("P2").frozen.length, 1);
  // 原样重放仍是幂等 duplicate，不会重复冻结
  assert.equal(service.applyEvent(original).status, "duplicate");
  service.applyEvent({ event_id: "uf-1", type: "freeze_lifted", payload: { freeze_id: "freeze:ent-x", entitlement_id: "E-X" } });
  assert.equal(service.applyEvent({ event_id: "c-x", type: "entitlement_confirmed", payload: { entitlement_id: "E-X" } }).status, "applied");
});

test("合并只迁移仍可兑现且符合目的地规则的项目", () => {
  const service = makeService();
  reserveFood(service, "E-F", "P2"); // B2 已装载到 CZ200
  service.applyEvent({ event_id: "c-f", type: "entitlement_confirmed", payload: { entitlement_id: "E-F" } });
  service.applyEvent({ event_id: "ent-l", type: "entitlement_reserved", payload: { entitlement_id: "E-L", passenger_id: "P2", flight_id: "CZ100", kind: "lounge_access", station_id: "L-CAN-01" } });
  const result = service.applyEvent(MERGE);
  assert.ok(result.derived.includes("MG1:migrate:E-F"));
  assert.ok(result.derived.includes("MG1:migrate:E-L"));
  const statement = service.passengerStatement("P2");
  assert.equal(statement.claimable[0].flight_id, "CZ200"); // 已确认 → 可领取
  assert.equal(statement.pending[0].flight_id, "CZ200");
  assert.ok(statement.changes.some((c) => c.entitlement_id === "E-F" && c.basis.includes("迁移")));
});

test("无装载交接的食品不迁移，转为未兑现责任并生成补偿", () => {
  const service = makeService();
  service.applyEvent({ event_id: "bat-3", type: "batch_registered", payload: { batch_id: "B3", supplier_id: "SUP-C", allergens: [], quantity: 5 } });
  reserveFood(service, "E1", "P3", "B3"); // B3 未装载到 CZ200
  service.applyEvent(MERGE);
  const statement = service.passengerStatement("P3");
  assert.equal(statement.unfulfilled.length, 1);
  assert.match(statement.unfulfilled[0].reason, /装载交接/);
  assert.equal(statement.unfulfilled[0].compensation.status, "offered");
  assert.ok(statement.affected_batches.some((b) => b.batch_id === "B3" && b.impacts.includes("未兑现")));
  const report = service.recoveryReport();
  assert.equal(report.pending_compensations.length, 1);
  // 补偿核销后责任闭环
  service.applyEvent({ event_id: "cf-1", type: "compensation_fulfilled", payload: { compensation_id: statement.unfulfilled[0].compensation.compensation_id } });
  assert.equal(service.recoveryReport().pending_compensations.length, 0);
  assert.equal(service.passengerStatement("P3").unfulfilled.length, 0);
});

test("目的地规则不允许的项目不迁移", () => {
  const service = makeService();
  service.applyEvent({ event_id: "rule-1", type: "destination_rule_registered", payload: { airport: "PEK", kind: "heritage_demo", allowed: false, note: "节假日期间暂停演示" } });
  service.applyEvent({ event_id: "ent-d", type: "entitlement_reserved", payload: { entitlement_id: "D1", passenger_id: "P2", flight_id: "CZ100", kind: "heritage_demo", staff_id: "ART-01" } });
  service.applyEvent(MERGE);
  const statement = service.passengerStatement("P2");
  assert.equal(statement.unfulfilled.length, 1);
  assert.match(statement.unfulfilled[0].reason, /目的地 PEK 规则不允许/);
});

test("活动人员取消后相关权益立即转为未兑现，不再显示可领取", () => {
  const service = makeService();
  service.applyEvent({ event_id: "ent-d", type: "entitlement_reserved", payload: { entitlement_id: "D1", passenger_id: "P2", flight_id: "CZ100", kind: "heritage_demo", staff_id: "ART-01" } });
  service.applyEvent({ event_id: "c-d", type: "entitlement_confirmed", payload: { entitlement_id: "D1" } });
  service.applyEvent({ event_id: "cancel-1", type: "staff_cancelled", payload: { staff_id: "ART-01" } });
  const statement = service.passengerStatement("P2");
  assert.equal(statement.claimable.length, 0);
  assert.equal(statement.unfulfilled.length, 1);
  assert.match(statement.unfulfilled[0].reason, /活动人员已取消/);
  assert.throws(
    () => service.applyEvent({ event_id: "ent-d2", type: "entitlement_reserved", payload: { entitlement_id: "D2", passenger_id: "P3", flight_id: "CZ100", kind: "heritage_demo", staff_id: "ART-01" } }),
    /活动人员已取消/,
  );
});

test("旅客过敏原与批次声明冲突时拒绝预留与确认", () => {
  const service = makeService();
  assert.throws(() => reserveFood(service, "E1", "P1", "B1"), /过敏原与批次声明冲突：花生/);
  // 预留后补充声明过敏原，确认时仍被拦截
  reserveFood(service, "E2", "P3", "B1");
  service.applyEvent({ event_id: "pax-3b", type: "passenger_registered", payload: { passenger_id: "P3", allergens: ["花生"] } });
  assert.throws(
    () => service.applyEvent({ event_id: "c-e2", type: "entitlement_confirmed", payload: { entitlement_id: "E2" } }),
    /过敏原与批次声明冲突/,
  );
});

test("批次召回产生未兑现责任，替代方案复核批准后恢复可领取", () => {
  const service = makeService();
  reserveFood(service, "E1", "P2", "B1");
  service.applyEvent({ event_id: "c1", type: "entitlement_confirmed", payload: { entitlement_id: "E1" } });
  service.applyEvent({ event_id: "recall-1", type: "batch_recalled", payload: { batch_id: "B1", reason: "检出未申报过敏原" } });
  let statement = service.passengerStatement("P2");
  assert.equal(statement.claimable.length, 0);
  assert.equal(statement.unfulfilled.length, 1);
  const b1 = statement.affected_batches.find((b) => b.batch_id === "B1");
  assert.ok(b1.impacts.includes("已召回") && b1.impacts.includes("未兑现"));
  // 替代方案：B1 → B2，复核批准
  service.applyEvent({ event_id: "sub-1", type: "substitution_proposed", payload: { substitution_id: "S1", entitlement_id: "E1", replacement_batch_id: "B2", proposer: { actor_id: "u1", role: "catering" } } });
  service.applyEvent({ event_id: "sub-1r", type: "substitution_reviewed", payload: { substitution_id: "S1", decision: "approve", reviewer: { actor_id: "u2", role: "quality" } } });
  statement = service.passengerStatement("P2");
  assert.equal(statement.unfulfilled.length, 0);
  assert.equal(statement.pending.length, 1);
  assert.equal(statement.pending[0].batch_id, "B2");
  const batches = Object.fromEntries(statement.affected_batches.map((b) => [b.batch_id, b.impacts]));
  assert.ok(batches.B1.includes("已替换"));
  assert.ok(batches.B2.includes("替换生效"));
  // 恢复后可重新确认领取
  assert.equal(service.applyEvent({ event_id: "c1b", type: "entitlement_confirmed", payload: { entitlement_id: "E1" } }).status, "applied");
});

test("高风险食品替换须不同角色复核，供应方不能批准自身批次", () => {
  const service = makeService();
  reserveFood(service, "E1", "P2", "B1"); // B1 高风险
  service.applyEvent({ event_id: "sub-1", type: "substitution_proposed", payload: { substitution_id: "S1", entitlement_id: "E1", replacement_batch_id: "B2", proposer: { actor_id: "u1", role: "catering" } } });
  assert.throws(
    () => service.applyEvent({ event_id: "rev-1", type: "substitution_reviewed", payload: { substitution_id: "S1", decision: "approve", reviewer: { actor_id: "u1", role: "quality" } } }),
    /不得为同一人/,
  );
  assert.throws(
    () => service.applyEvent({ event_id: "rev-2", type: "substitution_reviewed", payload: { substitution_id: "S1", decision: "approve", reviewer: { actor_id: "u2", role: "catering" } } }),
    /不同角色复核/,
  );
  assert.throws(
    () => service.applyEvent({ event_id: "rev-3", type: "substitution_reviewed", payload: { substitution_id: "S1", decision: "approve", reviewer: { actor_id: "u2", role: "quality", supplier_id: "SUP-B" } } }),
    /供应方不能批准自身批次/,
  );
  assert.equal(
    service.applyEvent({ event_id: "rev-4", type: "substitution_reviewed", payload: { substitution_id: "S1", decision: "approve", reviewer: { actor_id: "u2", role: "quality" } } }).status,
    "applied",
  );
  assert.equal(service.passengerStatement("P2").pending[0].batch_id, "B2");
});

test("调度进程重启后从事件账恢复未完成的迁移", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const ledgerPath = join(dir, "ledger.jsonl");
  // 直接写账，模拟结算完成前进程崩溃
  const ledger = new EventLedger(ledgerPath);
  for (const event of worldEvents()) ledger.append(event);
  ledger.append({ event_id: "ent-r1", type: "entitlement_reserved", payload: { entitlement_id: "E-R1", passenger_id: "P2", flight_id: "CZ100", kind: "festival_food", batch_id: "B2" } });
  ledger.append({ event_id: "merge-r", type: "flights_merged", payload: { merge_id: "MG-R", source_flight_ids: ["CZ100"], target_flight_id: "CZ200" } });

  const service = new Service({ ledgerPath });
  assert.deepEqual(service.recoveryReport().pending_migrations.map((p) => p.plan_id), ["MG-R"]);
  const { resumed_plans, report } = service.recover();
  assert.deepEqual(resumed_plans, ["MG-R"]);
  assert.equal(report.pending_migrations.length, 0);
  assert.equal(service.passengerStatement("P2").pending[0].flight_id, "CZ200");
  // 恢复幂等：再次恢复、重启后恢复都不重复结算
  assert.deepEqual(service.recover().resumed_plans, []);
  assert.deepEqual(new Service({ ledgerPath }).recover().resumed_plans, []);
});

test("航班拆分：被方案覆盖的旅客迁移，未覆盖的转为未兑现", () => {
  const service = makeService();
  service.applyEvent({ event_id: "flt-100a", type: "flight_registered", payload: { flight_id: "CZ100A", version: 1, origin: "CAN", destination: "PEK", aircraft: "A330" } });
  service.applyEvent({ event_id: "ldg-100a", type: "loading_recorded", payload: { flight_id: "CZ100A", version: 1, batch_id: "B2", quantity: 5 } });
  reserveFood(service, "E-S1", "P2");
  service.applyEvent({ event_id: "ent-s2", type: "entitlement_reserved", payload: { entitlement_id: "E-S2", passenger_id: "P1", flight_id: "CZ100", kind: "lounge_access", station_id: "L-CAN-01" } });
  service.applyEvent({ event_id: "split-1", type: "flight_split", payload: { split_id: "SP1", source_flight_id: "CZ100", parts: [{ flight_id: "CZ100A", passenger_ids: ["P2"] }] } });
  assert.equal(service.passengerStatement("P2").pending[0].flight_id, "CZ100A");
  const statement = service.passengerStatement("P1");
  assert.equal(statement.unfulfilled.length, 1);
  assert.match(statement.unfulfilled[0].reason, /未覆盖/);
});

test("旅客账单汇总可领取项目、变更依据、未兑现责任与受影响批次", () => {
  const service = makeService();
  reserveFood(service, "E1", "P2");
  service.applyEvent({ event_id: "c1", type: "entitlement_confirmed", payload: { entitlement_id: "E1" } });
  service.applyEvent(MERGE);
  const statement = service.passengerStatement("P2");
  assert.equal(statement.claimable.length, 1);
  assert.ok(statement.changes.every((c) => c.event_id && c.basis));
  assert.deepEqual(
    statement.changes.map((c) => c.basis),
    ["预留登记，占用节日食品唯一份额", "确认占用唯一份额", "航班拆并迁移 CZ100 → CZ200：仍可兑现且符合目的地规则"],
  );
  assert.equal(statement.unfulfilled.length, 0);
  assert.equal(statement.affected_batches.length, 0); // B2 全程正常，不算受影响
});
