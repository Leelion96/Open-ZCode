# 03: 本机 Docker 远端 E2E runner

Status: done

**Parent:** [数据同步：把本机配置推送到远端设备](../../remote/data-sync.md)

**What to build:** 开发者在自己的机器上（当前主要开发机是 Apple Silicon Mac，也支持 Linux），用一条命令完成以下 3 步，不需要专用 Linux 服务器、VPN、Xvfb 或代码同步：

1. **打 Linux 远端包**：执行 `ZCODE_ENV=test pnpm prepare:remote-assets:linux`，只构建 `linux-x64` 和 `linux-arm64`。用法见 [Bootstrap 命令](../../bootstrap.md)。
2. **新建 Linux 容器模拟远程机器**：复用现有的 `zcode-remote-ssh` 镜像（sshd + `dev` 用户），端口只绑定 `127.0.0.1`，设置随机密码。
3. **跑 E2E**：本机启动 wdio 运行指定 spec。Electron 经 SSH 连接容器，把对应架构的 Linux 包安装进容器，在真实的远端 zcode-server 上执行操作；用例用 docker exec 读取容器内的文件做断言。

运行结束时删除容器，失败或中断时也删除。数据同步的所有 E2E 都通过它运行。

**Blocked by:** None (can start immediately).

```text
开发机（本机）
 ├─ ① ZCODE_ENV=test pnpm prepare:remote-assets:linux
 │     └─ mock-cdn/releases/<版本>/：descriptor（只列 Linux 两个目标）+ linux-x64、linux-arm64 包
 │        + runner 构建凭证（ZCODE_ENV=test、源码指纹）
 ├─ ② docker：新建 Linux 容器 zcode-remote-ssh:test（架构跟随 Docker 主机，Apple Silicon 为 linux/arm64）
 └─ ③ wdio --spec（声明只需要 Linux 目标）
        ├─ Electron（ZCODE_ENV=test，本机原生运行，非 Linux 系统不套 Xvfb）
        │    └─ SSH ──▶ 127.0.0.1:<本次固定端口> ──▶ 容器：安装 Linux 包，启动远端 zcode-server
        └─ 断言 ── docker exec ──▶ 容器内 /home/dev/.zcode
结束 / 失败 / 中断 → 删除容器
```

## Acceptance criteria

### 打 Linux 远端包

- [x] runner 用 `ZCODE_ENV=test pnpm prepare:remote-assets:linux` 打包，不调用全平台的 `prepare:remote-assets`。
- [x] 默认每次运行都重新打包。只有构建凭证同时证明「产物是 test 构建」和「源码与本次一致」时才复用。不能证明时一律重建，避免误用开发时打的 production 包，或旧源码打出的包。
- [x] runner 向 wdio 声明「本次只需要 Linux 目标」。声明后，wdio 的远程资源就绪判断改为：读取 descriptor，确认它列出了 `linux-x64` 和 `linux-arm64`，并且对应的包都存在。缺失时调用 Linux 入口（`ZCODE_ENV=test`），不调用全平台入口。
- [x] 没有这个声明时（服务器队列、CI），wdio 的就绪判断和自动准备行为保持不变。

### Linux 容器

- [x] 镜像不存在时自动构建，已存在时直接复用。镜像定义与服务器 harness 共用同一份，不复制第二份 Dockerfile。
- [x] 每次运行新建容器，容器名带唯一后缀，并打上现有的 e2e 标签；同时运行多次不会互相干扰。
- [x] 每个容器设置随机密码。密码只通过环境变量传给 wdio，不写入文件，日志中脱敏。
- [x] 主机端口在本次运行内固定，容器 stop / start 后不变。提供让设备离线和恢复的 helper，供用例模拟断线。
- [x] 提供 docker exec helper，供用例读取容器内的文件和目录、修改权限，以便注入写失败等故障。

### 运行 E2E

- [x] 一条命令即可针对一个或多个 spec 运行；不传 spec 时给出明确的用法错误，不默认跑全量。
- [x] 注入的 `ZCODE_E2E_SSH_*` 环境变量与服务器 runner 一致：host、port、username、password、workspace path(s)、container。用例不需要区分是在本机还是在服务器上运行。
- [x] 非 Linux 系统直接启动 wdio，不套 Xvfb；Linux 上没有图形环境时沿用现有的 Xvfb 包装。
- [x] 运行结束、失败或被中断（Ctrl+C）时都删除本次容器；残留的同标签容器可以用一条命令清理。
- [x] Docker 未安装或未启动、依赖未安装时直接失败，并给出可读的原因，不进入打包或 wdio。

### 边界与文档

- [x] 不依赖 VPN、真实账号或模型回放隧道；需要这些能力的用例仍走服务器队列，本 runner 不承诺支持。
- [x] 不改变服务器队列（`run-queue` / `run-all-remote`）的现有行为。
- [x] 在 harness 的 README 中写明以下内容：
  - 用法，以及 3 个步骤分别做什么；
  - 前置条件：Docker Desktop 已启动，依赖已安装；
  - 限制：同机模拟，Windows 开发机不支持；
  - 跑完 E2E 后，发布目录里是 test 包；回到 `pnpm dev:desktop` 前，需要重新执行一次 `pnpm prepare:remote-assets:linux`（默认 production）。
- [x] 先补测试再改代码。

## Verification

- 单测：
  - 只列 Linux 目标的 descriptor 能通过「只需 Linux」模式的就绪判断；
  - 「只需 Linux」模式下永远不调用全平台入口；未声明时行为不变；
  - 打包时传入 `ZCODE_ENV=test`；构建凭证显示 production 或源码变化时会重建；
  - 环境变量注入、密码脱敏、非 Linux 不套 Xvfb、Docker 不可用时的报错、清理逻辑（用假的 docker 和 pnpm 执行器）。
- 本机实测（Apple Silicon Mac，当前版本还没有发布目录）：
  - 用 runner 跑一个现有的 SSH 远程用例，例如 SSH P0 的连接用例；
  - 确认只产出 Linux 两个包、没有构建 darwin 包；容器为 linux/arm64，安装的是 `linux-arm64` 包；用例通过；运行后没有残留容器；
  - 再跑一次，确认源码未变时复用已有包；中途按 Ctrl+C，确认容器被删除。
