/** 本地 JSON 命令入口。 */
import { readFile } from "node:fs/promises";
import { Service } from "./service.js";

const DEFAULT_LEDGER = "data/ledger.jsonl";

function ledgerPath(argv) {
  const index = argv.indexOf("--ledger");
  return index >= 0 ? argv[index + 1] : DEFAULT_LEDGER;
}

const [, , command, ...rest] = process.argv;
const positional = rest.filter((arg, index) => arg !== "--ledger" && rest[index - 1] !== "--ledger");

if (command === "validate" && positional[0]) {
  const service = new Service();
  const payload = JSON.parse(await readFile(positional[0], "utf8"));
  console.log(JSON.stringify(service.register(payload)));
} else if (command === "apply" && positional[0]) {
  const service = new Service({ ledgerPath: ledgerPath(rest) });
  const events = JSON.parse(await readFile(positional[0], "utf8"));
  const results = [];
  for (const event of Array.isArray(events) ? events : [events]) {
    try {
      results.push(service.applyEvent(event));
    } catch (error) {
      results.push({ status: "rejected", event_id: event?.event_id ?? null, reason: error.message });
    }
  }
  console.log(JSON.stringify({ results }, null, 2));
} else if (command === "statement" && positional[0]) {
  const service = new Service({ ledgerPath: ledgerPath(rest) });
  console.log(JSON.stringify(service.passengerStatement(positional[0]), null, 2));
} else if (command === "recovery") {
  const service = new Service({ ledgerPath: ledgerPath(rest) });
  console.log(JSON.stringify(service.recover(), null, 2));
} else {
  const service = new Service();
  console.log(JSON.stringify(service.health()));
}
