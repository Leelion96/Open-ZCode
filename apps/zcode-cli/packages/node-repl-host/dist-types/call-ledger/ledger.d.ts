import type { NodeReplCuaAppIdentity, NodeReplImage, NodeReplRequestMeta } from "@zcode/core/repl";
/** 一次 js 调用里由 broker 记下的可信事实。 */
export interface NodeReplCallFacts {
    /** CUA broker 从 runtime 结果读到的目标应用身份，按出现顺序。 */
    readonly cuaApps: NodeReplCuaAppIdentity[];
    /** 浏览器代理 broker 转发的成功截图，按出现顺序。 */
    readonly browserScreenshots: NodeReplImage[];
    /**
     * 浏览器代理 broker 收到过本次调用的 list / execute 请求，不论成败。供会话能力标签 `browser_use`
     * 派生（docs/design/v2/model/session-features-header.md「BUA/CUA 标签的补充规则」）。
     */
    browserUse: boolean;
    /** CUA broker 收到过本次调用的请求，含被 broker 拒绝的，不论成败。供会话能力标签 `computer_use` 派生。 */
    computerUse: boolean;
}
export interface NodeReplCallLedgerEntry {
    /** 只属于本次调用的 token，经 workerData 交给 Worker。 */
    readonly token: string;
    /** core 发出的 MCP 请求里的 request-context；broker 只用它构造会话信息。 */
    readonly requestMeta: Readonly<NodeReplRequestMeta>;
    readonly facts: NodeReplCallFacts;
}
export interface NodeReplOpenCall extends NodeReplCallLedgerEntry {
    /** tools/call 结束时调用；之后带这个 token 的请求一律拒绝。 */
    close(): void;
}
export interface NodeReplCallLedger {
    open(requestMeta: NodeReplRequestMeta): NodeReplOpenCall;
    /** 按 token 找到尚未关闭的调用；找不到（伪造、过期、非字符串）返回 undefined。 */
    resolve(token: unknown): NodeReplCallLedgerEntry | undefined;
}
export declare function createNodeReplCallLedger(): NodeReplCallLedger;
//# sourceMappingURL=ledger.d.ts.map