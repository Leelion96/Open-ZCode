# v3.15.1 合并边界

以 aac4755 的运行与构建结构为基础，保留品牌、资料隔离与自建服务替换；保持上游界面、交互、格式和换行。仅在已确认产品边界做差异，不全盘格式化或替换技术标识。

- 原五字段 product.json 继续注入 Desktop、Web、HTTP Host、内嵌 Agent 与 Node REPL；独立 CLI 未注入时保留上游默认。显式目录优先，不迁移或合并官方资料。
- 官方账号、套餐、Highspeed 入口及业务请求继续关闭；审计、遥测继续关闭。公告设备标识不启用上报或账号系统。
- 模型配置保留当前 revision 33、模板和参数规则；开发/生产遵循同一 Open-ZCode 规则。自建配置下发保持一致。
- readProductEndpointEnv 与 pickProductEndpointEnv 保留为兼容薄层，覆盖新增环境字段，地址解析由共享 endpoint 模块单独拥有。自建第一方服务与 relay 地址从同一 origin 派生，第三方模型地址不变。
- 独立 Web 保留无 Controller 列表读取修复；手机复用桌面既有 Host，不另起 Agent。本轮不实现 relay 后端。
- 采用上游插件源码、清单、版本、默认启用规则和 Gen UI 离线资源；替代旧的仅内置两个插件的限制。市场指向自建服务，不回落官方来源。
- 公告兼容上游交互，自建后端持有处理回执，详见 announcements.md。保留上游新增文档/测试，不恢复上游未重新引入的本地删除文件。

验证 Desktop/Web/HTTP/Agent/Node REPL 配置注入、默认启用集合与资源哈希；运行类型、lint、架构、格式和相关单测/E2E。品牌及目录复用现有用户资料验收，手机不宣称完成扫码联调。
