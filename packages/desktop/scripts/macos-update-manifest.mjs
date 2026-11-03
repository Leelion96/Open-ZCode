import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gte } from "semver";
import { parseDocument } from "yaml";

// electron-updater 比较 os.release()；macOS 13 对应 Darwin 22，不能填营销版本 13。
const MINIMUM_DARWIN_VERSION = "22.0.0";

export async function stampMacosUpdateManifests({ outputDir, platform }) {
  if (platform !== "mac") return;
  const entries = await readdir(outputDir, { withFileTypes: true });
  for (const entry of entries) {
    // 仅匹配 -mac.yml 会漏掉架构后缀和 .yaml，导致 CI 收集后丢失系统下限；仍限定 macOS 清单，避免改写其他平台。
    if (!entry.isFile() || !/-mac(?:-(?:arm64|x64))?\.ya?ml$/.test(entry.name)) continue;
    const file = join(outputDir, entry.name);
    const document = parseDocument(await readFile(file, "utf8"));
    if (document.errors.length > 0) throw document.errors[0];
    if (typeof document.get("version") !== "string") continue;
    const current = document.get("minimumSystemVersion");
    if (typeof current === "string" && gte(current, MINIMUM_DARWIN_VERSION)) continue;
    document.set("minimumSystemVersion", MINIMUM_DARWIN_VERSION);
    await writeFile(file, document.toString(), "utf8");
  }
}
