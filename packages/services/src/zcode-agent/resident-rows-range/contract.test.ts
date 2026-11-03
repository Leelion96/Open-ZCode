import { describe, expect, it, vi } from "vitest";
import { supportsResidentRowsRange } from "./contract.js";

describe("只读热会话 rowsRange 执行端能力", () => {
  it("同一 CLI 只查询一次，只有显式 true 才开启", async () => {
    const client = { request: vi.fn().mockResolvedValue({ residentRowsRange: true }) };
    expect(
      await Promise.all([
        supportsResidentRowsRange(client as never),
        supportsResidentRowsRange(client as never),
      ]),
    ).toEqual([true, true]);
    expect(client.request).toHaveBeenCalledTimes(1);
    const old = { request: vi.fn().mockResolvedValue({}) };
    expect(await supportsResidentRowsRange(old as never)).toBe(false);
  });
  it("查询失败按不支持处理且不缓存，下次重新确认", async () => {
    const client = {
      request: vi
        .fn()
        .mockRejectedValueOnce(new Error("Method not found"))
        .mockResolvedValueOnce({ residentRowsRange: true }),
    };
    expect(await supportsResidentRowsRange(client as never)).toBe(false);
    expect(await supportsResidentRowsRange(client as never)).toBe(true);
    expect(client.request).toHaveBeenCalledTimes(2);
  });
});
