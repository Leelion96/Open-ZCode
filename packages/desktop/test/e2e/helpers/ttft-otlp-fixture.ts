import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

/** 真实 OTLP 出口的隔离接收器；不拦截应用埋点，也不与其他 worker 共用固定端口。 */
export async function prepareTtftOtlpFixture(
  specs: string[],
): Promise<(() => Promise<void>) | null> {
  if (
    !specs.some((spec) => /conversation-session-ttft-(stages|diagnostics)\.test\.ts$/.test(spec))
  ) {
    return null;
  }
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../../../scripts/ttft-otlp-receiver.mjs", import.meta.url)), "0"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4000);
  });
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`OTLP receiver exited (${code}): ${stderr}`)));
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      const port = /OTLP receiver ready:(\d+)/.exec(output)?.[1];
      if (port) resolve(`http://127.0.0.1:${port}`);
    });
  });
  // signal 专属 endpoint/headers 优先于公共值，全部覆盖才能保证真实导出留在隔离接收器。
  const patch = {
    ZCODE_LOCAL_TTFT_ENABLED: "1",
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${endpoint}/v1/traces`,
    OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${endpoint}/v1/metrics`,
    OTEL_EXPORTER_OTLP_HEADERS: "",
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: "",
    OTEL_EXPORTER_OTLP_METRICS_HEADERS: "",
  };
  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  Object.assign(process.env, patch);
  return async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  };
}

export function ttftReceiverUrl(path: "/records" | "/reset"): string {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) throw new Error("TTFT worker 未启动隔离 OTLP 接收器");
  return `${endpoint}${path}`;
}
