# 手机日志通道（mobile-log / mobile-log-pull）

远控场景下，手机 App（KMP）的日志通过已配对的 relay 连接传到桌面，用于排查问题。分两种能力：

- **实时上传**：手机主动推 `mobile-log` 帧，桌面按设备和会话分文件落盘。
- **按需拉取**：桌面发 `mobile-log-pull-request`，手机按 cursor 分片回 `mobile-log-pull-response`，桌面导出成一个 JSONL 文件。

所有报文都是普通远控 app payload（`zcode_type` 区分），走现有 relay 加密通道，不新增连接。schema 定义在 `packages/shared/src/web-remote-relay/mobileLog.ts`，桌面收到后用 `parseWebRemoteControlAppPayload` 校验，非法报文直接丢弃。schema 不是 strict：多出来的字段会被忽略，方便手机新版本往前扩展。

## 公共结构

`MobileLogEntry`（推送帧和拉取分片共用）：

| 字段      | 类型                                     | 说明                                                      |
| --------- | ---------------------------------------- | --------------------------------------------------------- |
| `ts`      | int > 0                                  | 手机侧事件时间，epoch 毫秒                                |
| `level`   | `"debug" \| "info" \| "warn" \| "error"` | 其它值整帧拒绝                                            |
| `name`    | string ≤ 200，可选                       | 结构化事件名                                              |
| `tag`     | string ≤ 100，可选                       | 模块 / tag                                                |
| `message` | string ≤ 4000，可选                      | 正文，手机侧先截断。**手机必须先脱敏**（token、手机号等） |

## 实时上传：`mobile-log`（手机 → 桌面）

```json
{
  "zcode_type": "mobile-log",
  "device": {
    "id": "install-uuid",
    "name": "Pixel 8",
    "platform": "android",
    "appVersion": "1.2.0"
  },
  "sessionId": "app-launch-uuid",
  "events": [{ "ts": 1761184800000, "level": "info", "tag": "rc", "message": "paired" }]
}
```

- `events` 每帧 1..100 条。手机自己攒批（建议 1s 或 50 条触发一次），桌面不回 ack。
- `device.id`（1..128）作为设备目录名；不带时用配对时 `mobile-view-state` 里的设备名和平台。
- `sessionId`（1..128）表示一次 App 启动。同一会话写同一组文件；不带时用桌面的远控会话 sid。
- 桌面写盘排队超过 500 帧时丢弃新帧，只记一次 warn。

### 落盘位置

```
~/.zcode/v2/logs/mobile/<设备>/<YYYY-MM-DD>_<会话>.jsonl
                                 <YYYY-MM-DD>_<会话>.1.jsonl   # 滚动分片
```

- 设备和会话名做文件名安全化：只保留 `[A-Za-z0-9._-]`，最长 64 个字符。
- 每个新文件的首行是 header：`{"kind":"mobile-log-file","openedAt",...,"device","mobileSessionId","desktopSession","windowId"}`。之后每行一条：`{"time":ISO,"ts","level","tag","name","message"}`。
- 单文件 4 MiB 后滚动。单设备目录超过 32 MiB 时，按 mtime 删最旧的文件。超过 14 天的文件在进程内首次写入时清理。
- 目录在 `logs/` 下，所以 Help →「导出日志」打的 zip 会自动带上最近 3 天的手机日志。

## 按需拉取

### 请求 `mobile-log-pull-request`（桌面 → 手机）

```json
{
  "zcode_type": "mobile-log-pull-request",
  "requestId": "mobile-log-pull-<uuid>",
  "sinceTs": 1761098400000,
  "untilTs": 1761184800000,
  "minLevel": "info",
  "keyword": "relay",
  "maxEntries": 200000,
  "cursor": "opaque",
  "acceptEncodings": ["gzip"]
}
```

| 字段                  | 说明                                                         |
| --------------------- | ------------------------------------------------------------ |
| `requestId`           | 1..128，同一次拉取的所有分片共用                             |
| `sinceTs` / `untilTs` | 事件时间闭区间，可选                                         |
| `minLevel`            | 级别下限 debug < info < warn < error，可选                   |
| `keyword`             | ≤ 200，对 name/tag/message 做大小写不敏感的子串匹配，可选    |
| `maxEntries`          | 1..1,000,000。超出时保留最新的条目，并在应答里标 `truncated` |
| `cursor`              | ≤ 256。首片不带；续拉时原样带回上一片的 `cursor`             |
| `acceptEncodings`     | 桌面能解的压缩格式，目前只有 `gzip`。手机可以忽略，回明文    |

桌面菜单的默认请求是：最近 24 小时、全部级别、`maxEntries=200000`。

### 成功分片 `mobile-log-pull-response`（手机 → 桌面）

公共字段：

| 字段            | 说明                                                  |
| --------------- | ----------------------------------------------------- |
| `requestId`     | 与请求一致                                            |
| `success`       | `true`                                                |
| `totalMatched`  | 过滤后、截断前的匹配总数                              |
| `returnedCount` | 含本片在内，累计已返回的条数                          |
| `hasMore`       | 是否还有下一片                                        |
| `cursor`        | `hasMore=true` 时必带，≤ 256                          |
| `truncated`     | 可选，结果被 `maxEntries` 截断时为 true               |
| `sources`       | ≤ 8 个，每个 ≤ 64，例如 `["memory-ring","log-files"]` |

分片体二选一：

- **明文**：`"entries": MobileLogEntry[]`，最多 100 条。
- **gzip**：`"encoding": "gzip"`、`"data"`、`"entryCount"`。
  - `data` 是 base64(gzip(UTF-8 JSON 数组 `MobileLogEntry[]`))，最多 700,000 个字符。
  - `entryCount` 是解压后的条数（≤ 2000），桌面会校验。
  - 解压后最大 8 MiB。
  - 只有请求的 `acceptEncodings` 里有 `gzip` 时才允许用。

单个 relay 物理帧上限是 1 MiB。gzip 分片的 base64 上限定在 700k，就是给外壳留出余量。

### 失败应答

```json
{
  "zcode_type": "mobile-log-pull-response",
  "requestId": "…",
  "success": false,
  "reason": "busy",
  "error": "…"
}
```

`reason` ≤ 64，`error` ≤ 2000。`reason` 为 `unsupported-action` 时桌面提示升级 App，其它值统一提示「手机端返回错误」。

### 时序与背压

1. 桌面发首片请求（不带 cursor），启动 30s 单片超时。
2. 手机回一片。桌面解码、写入文件，**写完才**发下一片请求（同一 requestId，带回 cursor）。
3. `hasMore=false` 时结束。文件末行写 summary：`{"kind":"mobile-log-pull-summary","entryCount","totalMatched","shardCount",...}`。

防御措施：

- 同一连接同时只能有一个拉取。再触发会提示「正在拉取」。
- 单次拉取最多 5000 片，到上限按截断处理。
- 桌面处理上一片期间收到的同 requestId 应答当作重复，直接丢弃。超时或取消之后迟到的分片也丢弃。
- 远控连接停止或出错时，在途的拉取立即失败。

### 兼容与降级

手机不支持拉取时，按优先级从高到低：

1. 回 `app-error`：`{"zcode_type":"app-error","requestId":"<请求的 requestId>","reason":"unsupported-action","error":"…"}`。**推荐**，桌面会立即提示「手机端版本不支持日志拉取」。
2. 回 `success:false`，并带 `reason:"unsupported-action"`，效果同上。
3. 完全不回（旧版本会忽略未知报文）：桌面 30s 后按超时提示。

## 桌面入口与导出

- 远控面板：手机已连接时，连接卡片（设备行）上有「拉取手机日志」按钮，走桌面命令 `DesktopCommandIds.PullMobileLogs`。2026-10-28 起这是唯一用户入口，帮助菜单（macOS 原生菜单栏、Windows/Linux 工作区帮助按钮）里的同名项已移除。
- 目标连接：优先当前窗口已配对的远控连接，其次任一已配对窗口。没有已配对连接时弹框说明。
- 导出文件：`~/.zcode/export-log/mobile-logs-<设备>-<YYYYMMDD-HHmmss>.jsonl`。完成后弹框给出文件路径和实时日志目录，可「打开所在文件夹」。
- 文件在收到第一片有效数据（或成功结束）时才创建，并以独占方式打开，绝不覆盖已有文件。
- 中途失败时：已经写入了条目，就保留这份部分文件，并在弹框里说明；一条都没写，就删除文件。

### 桌面日志

拉取统一打 `[web-remote-control]` 前缀、关键字 `zcode_rc_log_pull`：

- `[web-remote-control] zcode_rc_log_pull_start`：开始拉取，带 `window`、`since_ts`、`until_ts`、`max_entries`。
- `[web-remote-control] zcode_rc_log_pull_result`：结束，成功 info、失败 warn。字段：`request_id`（成功时）、`outcome`（`ok` / `error`）、`error_code`、`error_msg`、`duration_ms`、`bytes`（写入文件的字节数，含 header 和 summary）、`entries`、`shards`、`compressed_shards`、`truncated`、`file`（只有文件名）。

## 代码位置

| 内容          | 文件                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------- |
| schema / 上限 | `packages/shared/src/web-remote-relay/mobileLog.ts`                                      |
| 实时落盘      | `packages/desktop/src/main/web-remote-relay/mobileLogSink.ts`                            |
| 拉取编排      | `packages/desktop/src/main/web-remote-relay/mobileLogPull.ts`                            |
| 导出与弹框    | `packages/desktop/src/main/web-remote-relay/mobileLogPullExport.ts`                      |
| 路由接入      | `packages/desktop/src/main/webRemoteControlManager.ts`：`routePayload`、`pullMobileLogs` |
| 面板入口      | `packages/ui/src/web-remote-control/WebRemoteControlDialog.tsx`                          |
