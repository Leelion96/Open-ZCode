/**
 * world-read 的上限常量。
 *
 * **执行在 driver，常量在纯包**，两件事分开是有原因的：只有 driver 那一侧能"不生产"——
 * 让 ripgrep 在 2000 条上停手，胜过物化一百万条再回头量。但常量属于契约而不是 driver
 * 私有：引擎与编译侧的用例要按它们断言，而一个只写在 driver 里的数字，测试只能复制一份，
 * 于是有一天两份不相等。
 *
 * 溢出的策略是**拒绝节点**（`WorldReadCapExceeded`，脚本可 `catch`），绝不截断后加个标志位。
 * 截断把一份悄悄残缺的世界视图交给脚本，而脚本接下来会拿它去扇出——扇出才是贵的那一步。
 */

/**
 * `world.run` 每路输出的 journal 预算（16 MiB）。它不是模型上下文预算：`dwf_node.result_json`
 * 原样存结果、resume 原样重放，所以脚本拿到的值与 journal 里的值必须逐字节相同——超出就只能
 * 拒绝，不能截断。脚本若要有界的输出，在调用点用 `opts.output`（`"discard"` / `{ tail }`）声明，
 * 两份拷贝就是同一份有界的东西。`{ tail: n }` 的上限也取这个数。
 */
const RUN_STREAM_MAX_BYTES = 16 * 1024 * 1024;

/** grep / git.diff / git.log 的上限。数字即契约（见本模块顶部）。 */
export const WORLD_READ_CAPS = {
  /**
   * `files.glob` 的最大匹配文件数。之前 glob 没有自己的 cap，于是文件系统
   * 端口面向 UI 工具的默认值（100，mtime 降序）静默生效——正是本注册表要禁止的
   * "静默夹到上限"。所有 world-read 的 cap 都必须在这里拥有名字。
   */
  globMaxFiles: 2000,
  /** `files.grep` 的最大命中条数。 */
  grepMaxMatches: 2000,
  /** `files.grep` 结果序列化后的最大字节数（与条数上限**先到先拒**）。 */
  grepMaxSerializedBytes: 256 * 1024,
  /** `git.diff` 输出的最大字节数。 */
  gitDiffMaxBytes: 512 * 1024,
  /** `git.log` 可请求的最大条数；超过即结构化拒绝，而不是静默夹到上限。 */
  gitLogMaxCount: 100,
  /** `git.log` 未指定 count 时的条数。 */
  gitLogDefaultCount: 20,
  /** `world.run` `output: "full"` 时 stdout 的最大字节数（拒绝不截断，cap+1 探测）。 */
  runStdoutMaxBytes: RUN_STREAM_MAX_BYTES,
  /** `world.run` `output: "full"` 时 stderr 的最大字节数（同上）。 */
  runStderrMaxBytes: RUN_STREAM_MAX_BYTES,
  /** `world.run` 未指定 timeoutMs 时的墙钟（ms）。**无上限钳制**：为真正长跑的测试设计。 */
  runDefaultTimeoutMs: 300_000,
} as const;
