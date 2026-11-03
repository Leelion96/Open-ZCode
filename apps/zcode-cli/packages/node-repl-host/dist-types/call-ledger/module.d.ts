/**
 * node-repl-call-ledger 模块清单（architecture-governance managed 模块）。
 * 层：adapters（开本机 socket）。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export declare const nodeReplCallLedgerModule: {
    readonly id: "node-repl-call-ledger";
    readonly requires: readonly ["zcode-cli"];
    readonly provides: readonly ["node-repl-call-ledger"];
    readonly publicEntrypoints: readonly ["contract.ts"];
};
//# sourceMappingURL=module.d.ts.map