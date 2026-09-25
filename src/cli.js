/** 本地 JSON 命令入口。 */
import { readFile } from "node:fs/promises";
import { Service } from "./service.js";

const service = new Service();
if (process.argv[2] === "validate" && process.argv[3]) {
  const payload = JSON.parse(await readFile(process.argv[3], "utf8"));
  console.log(JSON.stringify(service.register(payload)));
} else {
  console.log(JSON.stringify(service.health()));
}
