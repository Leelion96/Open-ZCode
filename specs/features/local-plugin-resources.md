# 内置插件与自建市场

## v3.15.1 产品规则

沿用上游插件源码、seed 清单、版本、默认启用规则与 Visualize/Gen UI 资源，取代旧的仅内置两个插件的限制。市场仍通过 ZCODE_BASE_URL 与兼容别名访问 /api/v1/plugins/marketplace.json，技术 ID 为 zcode-plugins-official；不回落官方来源。自建市场负责其目录与发行工件。依赖官方账号的业务能力继续关闭，不改变个人来源、用户已安装插件及既有启停状态。

## 所有者与验证

上游定义与打包清单持有内置资源，客户端构建不读取相邻 Server 源码。复用既有安装、缓存、来源切换与 stale 刷新防护。验证默认启用集合、版本、必需文件、Gen UI 离线哈希与自建市场刷新，保持 workspaceIdentity、owner/lease 和存量数据。
