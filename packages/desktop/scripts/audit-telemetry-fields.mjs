import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { auditTelemetryFields } from "./lib/telemetry-field-contract.mjs";

const { values } = parseArgs({
  options: {
    capture: { type: "string" },
    "artifact-dir": { type: "string" },
    "no-sync": { type: "boolean", default: false },
  },
});
if (!values.capture) throw new Error("需要 --capture <本轮 telemetry parity JSON>");
const capture = JSON.parse(await readFile(values.capture, "utf8"));
if (!Array.isArray(capture.eventReport)) throw new Error("capture.eventReport 必须是数组");
const result = await auditTelemetryFields({
  records: capture.eventReport,
  artifactDir: values["artifact-dir"],
  sync: values["no-sync"] ? false : undefined,
});
console.log(JSON.stringify(result, null, 2));
if (result.errors.length) process.exitCode = 1;
