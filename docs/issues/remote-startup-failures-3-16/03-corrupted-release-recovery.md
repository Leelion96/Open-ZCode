# 已安装 release 损坏后无法自愈

Status: done

所属：[01 分诊记录](01-source-server-startup-failure-triage.md) D 类。

## 现象

ZCT-2112751986554916864、ZCT-2112751995913146368、ZCT-2112751992984584192、ZCT-2112751990526722048（同一用户、同一设备，1 秒内重复提交）：
Windows 桌面端 3.16.2 经 SSH 连接，`Starting Source Server` 后报 `node:internal/modules/run_main:92`
（`ERR_INVALID_PACKAGE_CONFIG`，Node v22.16.0 为随包运行时），重试一直失败。

## 根因（2026-10-24 确认）

“不能自愈”由两个决定共同造成，二者都符合当时的规格，属于设计缺口：

```text
（来源未知）releases/<id>/runtime/package.json 变成非法 JSON
  → probe：bin/zcode 存在 + current.json 版本兼容 → 判为已安装（不读 release 内容）
  → serve --daemon：Node 判断入口格式时读到非法 package.json，Server CLI 未执行即 exit 1
  → 通用“连接失败” → 重试回到同一路径                     ① 没有“已安装但不可执行”的出口
  → 即使同版本重装：promote 发现目标已存在且整树 hash 偏离记录
  → Existing immutable release conflict                      ② 本地损坏被当成身份冲突
```

- ① Desktop 连接流程（`sourceServerConnectionManager.ts` 的 probe → ensureDaemon）只在“未安装 / 版本不兼容”时安装；
  界面上没有同版本重装入口，设备卡的“更新”只在有可用或必须更新时出现。
- ② `immutableRelease.ts` 的 `assertExistingReleaseMatches` 只有复用和冲突两种结论；旧 R2 规格要求“内容不一致必须失败”，
  `releaseInstaller.test.ts`、`componentCache.test.ts` 也按此断言。
- 只有“Desktop 版本 = 损坏 release 版本”时会卡住：升级到不同版本时 releaseId 不同，不会冲突（实测 3.16.2 损坏后装 3.16.3 恢复）。

证据（容器 debian:13-slim amd64，官方 3.16.2 linux-x64 包 sha256 `947eb91d…`，远端命令逐字取自 v3.16.2）：
`package.json` 为空 / 截断 / 全 NUL 时 `serve --daemon` 输出与工单逐字相同；同 archive 重装（带或不带 `--force`）
返回 `Existing immutable release conflict … identity mismatch`；只有删除 `releases/<id>` 后重装可恢复。
Node 只在入口文件存在时才读最近的 `package.json`，所以坏的是 release 自带的 `runtime/package.json`。

## 损坏来源（未知）

已排除产品自身：v3.16.2 只有构建期 `stage.ts` 写该文件；安装进程在 0.5–8 秒间 8 个时刻 kill -9 后 release
要么不存在要么完整；并发安装被 `update.lock` 拒绝；正常运行 15 秒 release 无文件变化。剩余候选：主机崩溃 / 断电
（server-cli 全程无 fsync，推断未证实）、外部写入、存储故障。需要现场材料：该文件的 `stat`/`xxd`、release 与 archive
逐文件对比（坏一个还是一批）、文件系统类型、重启记录与安装时间。

## 决定与修复（2026-10-24）

- 服务端：同身份损坏副本在同 archive 安装时整体替换，记录缺失或身份不同仍冲突。规格见
  [R2 immutable promote](../../architecture/r2-server-cli-and-daemon.md)。
- 桌面端：按原型方案 C 提供「重新安装远端服务」——设备卡「更多」常驻，连接失败时设备卡错误条与连接向导失败页就地提供。
  复用更新链，不新增 Host 接口。规格见 [RDRI-01](../../architecture/remote-device-connection-ux-spec.md#重新安装远端服务rdri-012026-10-24)。
- 不做自动修复，不在 probe 中做完整性校验；不为未证实的损坏来源补 fsync。

## 验证（2026-10-24）

- 服务端：`releaseInstaller.test.ts`、`componentCache.test.ts` 覆盖空 / 截断 / NUL / 篡改四种损坏的修复，以及记录缺失、
  身份不同时仍冲突；修复前 5 例失败、修复后通过。
- UI：`packages/ui/test/sourceServerReinstallEntry.test.ts` 覆盖可用规则、确认文案、菜单位置、错误条与向导按钮。
- E2E（pending，待人工复核）：`conversation-session-r3-reinstall-damaged-release.test.ts`（R3A-BLD-12），本机 Docker
  runner，macOS → Linux arm64，run `local-docker-20261024053234-87ead8` PASS。损坏后 `serve --daemon` 复现
  `ERR_INVALID_PACKAGE_CONFIG`；设备卡错误条与会话横幅「重新连接」打开的向导失败页各重装一次，releaseId 不变、
  `package.json` 恢复、`releases/` 无隐藏残留，设备回到已连接。深浅主题截图在同一工件目录。
- 未验证：Windows / WSL / Docker 目标的实际重装；x64 远端；手机端不涉及。
