import { defineConfig } from "vitest/config";

// 放在模块目录里：包根目录往上会先找到 apps/zcode-cli 的配置，它只收 test/ 下的用例。
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["**/*.test.ts"],
  },
});
