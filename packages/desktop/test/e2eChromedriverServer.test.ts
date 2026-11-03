import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startE2EChromedriverServer } from "../scripts/e2e-chromedriver-server.mjs";

const roots: string[] = [];
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(stops.splice(0).map((stop) => stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), "zcode-driver-server-"));
  roots.push(root);
  const script = join(root, "driver.mjs");
  await writeFile(script, source);
  return {
    executablePath: process.execPath,
    prefixArgs: [script],
    logPath: join(root, "driver.log"),
  };
}

describe("E2E ChromeDriver 端口所有权", () => {
  it("由驱动绑定端口 0，读回真实端口；就绪后始终持有端口，停止后释放", async () => {
    const input = await fixture(`
      import {createServer} from 'node:http';
      if(!process.argv.includes('--port=0'))throw Error('Driver must own port allocation');
      const server=createServer((req,res)=>res.end(JSON.stringify({value:{ready:true}})));
      server.listen(0,'127.0.0.1',()=>{
        process.stdout.write('ChromeDriver was started successfully on port ');
        setImmediate(()=>process.stdout.write(server.address().port+'.\\n'));
      });
    `);
    const driver = await startE2EChromedriverServer(input);
    stops.push(driver.stop);
    expect(driver.port).toBeGreaterThan(0);
    expect(driver.hostname).toBe("127.0.0.1");
    expect(await (await fetch(`http://${driver.hostname}:${driver.port}/status`)).json()).toEqual({
      value: { ready: true },
    });
    const competitor = createServer();
    await expect(
      new Promise((resolve, reject) => {
        competitor.once("error", reject);
        competitor.listen(driver.port, driver.hostname, resolve);
      }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    competitor.close();
    await driver.stop();
    await expect(fetch(`http://${driver.hostname}:${driver.port}/status`)).rejects.toThrow();
    expect(await readFile(input.logPath, "utf8")).toContain(`port ${driver.port}`);
  });

  it("驱动启动失败立即报告原始错误，不把别的监听端口或退出码零当成就绪", async () => {
    const input = await fixture("console.error('bind() failed: Address already in use');");
    await expect(startE2EChromedriverServer(input)).rejects.toThrow("bind() failed");
    expect(await readFile(input.logPath, "utf8")).toContain("Address already in use");
  });

  it("启动没有产生就绪事件时按上限终止，只启动一次", async () => {
    const input = await fixture("console.log('STARTED_ONCE');setInterval(()=>{},1000);");
    await expect(startE2EChromedriverServer({ ...input, timeoutMs: 250 })).rejects.toThrow(
      "ChromeDriver startup timed out",
    );
    expect((await readFile(input.logPath, "utf8")).match(/STARTED_ONCE/gu)).toHaveLength(1);
  });
});
