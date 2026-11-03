import { resolve } from "node:path";
import { createServer } from "vite";

const webRoot = resolve(import.meta.dirname, "../../web");
// 端口由夹具传入；"0" 表示独立夹具，从 5174 开始由 Vite 自行绑定空闲端口（Vite 把 0 当作默认端口）。
const requestedPort = process.argv[2] || "5173";
const server = await createServer({
  root: webRoot,
  configFile: resolve(webRoot, "vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port: requestedPort === "0" ? 5174 : Number(requestedPort),
    strictPort: requestedPort !== "0",
  },
  optimizeDeps: {
    // 根因：冷缓存下迟发现此 Worker 会触发 full-reload，中断已开始的手机触摸操作。
    // 首轮就声明测试会使用的入口，不等待旧缓存或重试用户操作。
    include: ["@pierre/diffs/worker/worker.js"],
  },
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
await server.listen();
server.printUrls();
