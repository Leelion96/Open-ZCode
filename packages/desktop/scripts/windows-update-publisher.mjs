import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { readWindowsAuthenticodeSignature } from "./powershell-command.mjs";

export async function writeWindowsUpdatePublisher({
  appOutDir,
  executableName,
  readSignature = readWindowsAuthenticodeSignature,
}) {
  // 当前 electron-updater 缺少 publisherName 时会跳过自定义校验。
  // 保留签名身份以激活运行时的有效性检查；它不再作为 DN 白名单。
  const signature = await readSignature(join(appOutDir, `${executableName}.exe`));
  if (
    signature.status !== 0 ||
    typeof signature.subject !== "string" ||
    !signature.subject.trim()
  ) {
    throw new Error("Windows update publisher requires a valid signed application certificate");
  }
  const configPath = join(appOutDir, "resources", "app-update.yml");
  const config = parse(await readFile(configPath, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config) || !config.provider) {
    throw new Error("Windows update configuration is missing a provider");
  }
  config.publisherName = [signature.subject.trim()];
  await writeFile(configPath, stringify(config), "utf8");
}
