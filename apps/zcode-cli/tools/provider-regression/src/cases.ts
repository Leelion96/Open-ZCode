import type { ModelProperties } from "@zcode/contracts";

export type CaseKind =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "tool"
  | "json"
  | "web"
  | "system"
  | "context"
  | "reasoning"
  | "output";
export interface RegressionCase {
  id: string;
  kind: CaseKind;
  applies(properties: ModelProperties): boolean;
}
const text = (p: ModelProperties) => p.inputFormat.supportsText && p.outputFormat.supportsText;
export const cases: readonly RegressionCase[] = [
  { id: "TEXT-001", kind: "text", applies: text },
  { id: "IMAGE-001", kind: "image", applies: (p) => p.inputFormat.supportsImage },
  { id: "VIDEO-001", kind: "video", applies: (p) => p.inputFormat.supportsVideo },
  { id: "AUDIO-001", kind: "audio", applies: (p) => p.inputFormat.supportsAudio },
  { id: "PDF-001", kind: "pdf", applies: (p) => p.inputFormat.supportsPdf },
  { id: "TOOL-001", kind: "tool", applies: (p) => p.supportsToolCall },
  { id: "JSON-001", kind: "json", applies: (p) => p.supportsJsonSchemaOutput },
  { id: "WEB-001", kind: "web", applies: (p) => p.supportsNativeWebSearch },
  { id: "SYSTEM-001", kind: "system", applies: (p) => p.supportsMidConversationSystem },
  { id: "CONTEXT-001", kind: "context", applies: text },
  { id: "REASON-001", kind: "reasoning", applies: text },
  { id: "OUTPUT-001", kind: "output", applies: text },
];
export function selectCases(ids: string[]): readonly RegressionCase[] {
  if (ids.includes("*")) {
    if (ids.length !== 1) throw new Error("* 不可与具体用例混用");
    return cases;
  }
  // 旧编号重复执行同一场景；兼容历史清单，但不重复发起计费请求。
  return [...new Set(ids.map((id) => (id === "TOOL-002" ? "TOOL-001" : id)))].map((id) => {
    const test = cases.find((c) => c.id === id);
    if (!test) throw new Error("测试清单引用了不存在的用例");
    return test;
  });
}

export const REASONING_TASK_ID = "task-platform-v1";
export const REASONING_SECTIONS = [
  "目标与边界",
  "组件与数据",
  "状态与时序",
  "故障推演",
  "方案取舍",
  "验证与运维",
] as const;
export const REASONING_PROMPT = `请为一个多租户长任务执行平台做可落地的架构设计，不能只罗列组件名称。

场景与约束：
- 2000 个租户，峰值每秒提交 300 个任务，每个任务执行 1 秒到 30 分钟；客户端超时后可能重复提交。任务会调用外部接口产生副作用。
- PostgreSQL 是现有持久存储，消息队列只保证至少一次投递，Worker 无状态、可水平扩容；不要引入全局分布式事务。
- Worker 可能在任何时刻崩溃、网络隔离或长时间暂停；租约到期后旧 Worker 仍可能恢复，两个 Worker 可能认为自己拥有同一任务。
- 一类外部接口支持幂等键和按键查询结果，另一类两者均不支持；外部操作成功但响应丢失是必须处理的真实情况。
- 用户可以取消任务；取消、完成和重试可能并发发生。客户端需要断线重连后恢复正确状态，不能把 UI 状态当事实源。
- 要有租户配额与公平调度；高优先级任务不能长期饿死低优先级任务。部署在两个地域，跨地域网络可能中断，必须说明灾备目标和承诺边界。

请分析约束冲突后提出一套最终方案。按下面六个 Markdown 二级标题输出，每节给出具体设计及理由，总回答约 1200—1800 个中文字，不输出代码实现：
## 1. 目标与边界
写出关键不变量、可保证和不可保证的语义，尤其区分任务状态与外部副作用。
## 2. 组件与数据
明确事实源、最小数据表、唯一键、索引、事务边界，以及提交成功但消息未发出时怎样恢复。
## 3. 状态与时序
给出状态转换和一段文字箭头时序图，说明所有权、租约、版本或 fencing、幂等、取消和终态竞争。
## 4. 故障推演
逐一推演：提交后未入队；外部成功但未记录；旧 Worker 恢复；取消与完成竞争；跨地域隔离。写出可观察状态及恢复动作，不能把所有问题都交给重试。
## 5. 方案取舍
比较至少两个可行方案并明确选择；说明外部接口不支持幂等和查询时怎么避免虚假的 exactly-once 承诺，以及吞吐、公平和一致性的代价。
## 6. 验证与运维
给出至少五个可证伪的故障注入测试、关键指标和告警、人工介入条件，以及恢复目标的验收方法。`;
