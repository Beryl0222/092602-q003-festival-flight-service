/** 节日航班服务包重排的应用服务入口。 */
import { createRecord } from "./domain.js";
import { Repository } from "./repository.js";

export class Service {
  constructor(repository = new Repository()) { this.repository = repository; }
  health() { return { service: "festival_flight_service", status: "ok" }; }
  register(payload) { return this.repository.add(createRecord(payload)); }
  find(recordId) { return this.repository.get(String(recordId)); }
}
