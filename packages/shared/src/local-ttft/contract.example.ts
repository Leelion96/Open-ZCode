import { localTtftContextSchema } from "./contract.js";

/** 验证入口只接纳关联 ID 与本地出口选择，不携带业务内容。 */
export function validateLocalObservation(value: unknown) {
  return localTtftContextSchema.safeParse(value);
}
