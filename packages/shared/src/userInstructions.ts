/** 用户自定义指令（~/.zcode/AGENTS.md，设置页「个性化」）的字节上限。
 * 与 CLI 侧读取截断保持一致：apps/zcode-cli/packages/adapters/src/context/index.ts
 * 的 DEFAULT_MAX_BYTES（100KB，超出部分 Agent 静默不读）。两侧改动必须同步；
 * 服务层按此常量做最终校验，防止其他 RPC 调用方绕过 UI 写入超限内容。 */
export const USER_INSTRUCTIONS_MAX_BYTES = 100 * 1024;

/** saveUserInstructions 拒绝超限内容时抛出的错误码。 */
export const USER_INSTRUCTIONS_TOO_LARGE_ERROR_CODE = "user_instructions_too_large";
