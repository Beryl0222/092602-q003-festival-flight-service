import test from "node:test";
import assert from "node:assert/strict";
import { Service } from "../src/service.js";

const sample = {"record_id": "flight-CZ100", "owner_id": "service-control", "state": "planned", "revision": 1};

test("健康检查返回服务状态", () => {
  assert.equal(new Service().health().status, "ok");
});

test("登记后可以按编号查询", () => {
  const service = new Service();
  const saved = service.register(sample);
  assert.equal(saved.revision, 1);
  assert.equal(service.find(saved.record_id).owner_id, saved.owner_id);
});

test("重复编号被拒绝", () => {
  const service = new Service();
  service.register(sample);
  assert.throws(() => service.register(sample), /已存在/);
});
