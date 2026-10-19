# Composer 工具栏布局

登记现有 `useComposerToolbarFit` 和 `fitComposerToolbar` 的布局职责，保留原入口和实现。

- 只读取工具栏 DOM 尺寸、更新紧凑显示属性；不持有模型选择、权限或会话状态。
- React hook 统一管理尺寸及内容观察器，并在卸载时清理；测量副本不改变实际控件交互。
- 普通入口与合并模型入口沿用各自已有的收缩顺序；桌面与窄屏共用同一布局函数。
- 契约测试验证公开布局入口；各档位回归继续由 `composerToolbarFit.test.ts` 覆盖。
