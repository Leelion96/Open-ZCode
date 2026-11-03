import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["tests/**/*.test.ts", "contract.test.ts"], testTimeout: 15000 },
});
