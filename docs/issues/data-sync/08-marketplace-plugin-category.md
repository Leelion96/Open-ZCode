# 08: marketplace 插件分类

Status: done

**Parent:** [数据同步：把本机配置推送到远端设备](../../remote/data-sync.md)

**What to build:** 「插件」分类加入本机安装的 marketplace 插件，只处理 scope 为 user 的插件。

- 新建：网络来源（github / git / url）直接在远端 add marketplace；Personal Source 的本地目录类来源，先把 marketplace 清单和所选插件的源码镜像到远端再 add。之后在远端安装，设置启用状态，并同步安全子集的 options。
- 比较：只比较两端 overview 中的版本号。
- 更新：只有远端来源的最新版本正好等于本机版本时，才允许勾选「更新」。
- 远端版本较新的项不可选，因为不能指定版本或降级。
- Orphaned Installed Plugin 显示为「来源已删除」，不可同步；Builtin Plugin 不列出。
- 远端 add / install 期间，该行显示「停止」，用户可以单独停止这一项。弹窗没有全局取消，推送中仍不能关闭。

**Blocked by:** [07: inline 插件分类](07-inline-plugin-category.md)

## Acceptance criteria

- [x] 候选只包含 scope 为 user 的 marketplace 插件；Builtin Plugin 和官方资源包自带的插件不列出。
- [x] 对齐 key 为 `name@marketplace`；版本取自两端 overview，版本相同即为「已同步」。
- [x] 新建流程复用现有的 add / 镜像 / install / 启用 / configure 能力。编排以 source / target 为参数，不写死「本机为来源」，为以后的拉取方向保留可能。
- [x] 「更新」仅在远端来源最新版本等于本机版本时可选，否则该行不可选，原因写「远端来源的最新版本与本机不一致」。更新完成后核对远端版本；与本机不一致时，该项标记为失败。
- [x] 远端版本较新时显示黄色「差异」，该行不可勾选。
- [x] Orphaned Installed Plugin（本机来源已删除）不可同步，原因写「来源已删除」；镜像不支持跨 marketplace 的依赖，遇到时该项不可同步并说明原因。
- [x] 每一项可单独失败。
- [x] 远端 add / install 期间，该行显示「停止」，复用现有的 `cancelPluginOperation`；停止只作用于该行。弹窗没有全局取消；推送中仍禁止关闭弹窗。
- [x] 中英文文案齐全。
- [x] 先补测试再改代码。

## Verification

- Seam ②：注入假的本机 / 远端 Agent 服务与 overview，断言版本比较、更新可选条件、远端较新不可选、Orphaned 与 Builtin 的处理、按行「停止」调用 `cancelPluginOperation`，以及调用顺序产生的最终结果。
- Seam ①：Personal Source 镜像归档的导出与导入（沿用现有插件同步服务测试）。
- Seam ③：用新弹窗推送一个本地目录来源的 marketplace 插件，在远端断言已安装且启用状态一致。覆盖原 WPL-011 用例的场景。
