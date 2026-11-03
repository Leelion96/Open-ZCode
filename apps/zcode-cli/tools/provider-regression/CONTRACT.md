# Provider regression

独立开发工具，通过 contract.ts 的 run 接口读取显式 Provider 配置与清单，按 Provider / Model / Case 三级上限运行适用用例并持续保存脱敏快照。详细行为唯一来源为 docs/builtin-provider-maintenance/regression-testing.md。

输入配置由 Schema 校验；会话、附件与工具复用公开 ZCode App；专项调用复用产品处理函数和 Model Adapter。临时会话关闭后清理，取消传递给在途请求。保留产品重试，不读取日常用户配置，不修改产品配置。副作用限于指定供应商调用、独立临时会话与报告目录写入。

执行器独占状态，结果写入队列串行保存不可变快照。首次计划和每项开始 / 结束均须持久化；写入失败停止请求。outputDir 是报告根目录，省略时使用 Provider 配置旁的 reports，每轮创建独立 runId 子目录。HTML 转换入口只读取结果，不加载凭据或请求网络。
