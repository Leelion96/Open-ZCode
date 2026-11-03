import { useCallback, useLayoutEffect, useRef } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";

export function useConfirmDialog() {
  return useConfirmDialogStore((state) => state.requestConfirmation);
}

/** 只包装显式入口；scope 必须稳定，并随原状态 owner 的目标换代而改变。 */
export function useYoloModeConfirmation(scope: unknown, currentMode: string | undefined) {
  const { intl } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const pending = useRef<AbortController | null>(null);
  useLayoutEffect(
    () => () => {
      // 不能只在弹窗关闭时检查 mounted：确认结算与微任务提交之间也可能发生导航。
      pending.current?.abort();
      pending.current = null;
    },
    [scope, currentMode],
  );

  return useCallback(
    (nextMode: string, apply: () => void) => {
      if (
        pending.current ||
        useConfirmDialogStore.getState().pendingRequest?.presentation === "yolo-confirmation"
      )
        return;
      if (nextMode !== "yolo" || currentMode === "yolo") {
        apply();
        return;
      }
      const controller = new AbortController();
      pending.current = controller;
      void requestConfirmation(
        {
          title: intl.formatMessage({ id: "mode.yoloConfirmation.title" }),
          presentation: "yolo-confirmation",
        },
        controller.signal,
      ).then((confirmed) => {
        if (pending.current === controller) pending.current = null;
        if (confirmed && !controller.signal.aborted) apply();
      });
    },
    [currentMode, intl, requestConfirmation, scope],
  );
}
