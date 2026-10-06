import { useState } from "react";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildLoginApiKeySkipSettings,
  resolveLoginApiKeyDefaultProvider,
} from "@/login/LoginApiKeyForm.helpers.js";
import { useServices } from "./useServices.js";

export function useSkipLogin(onComplete: (reason: "skip") => void | Promise<void>) {
  const { intl, locale } = useZCodeIntl();
  const { settingService } = useServices();
  const [skipping, setSkipping] = useState(false);
  const skipLogin = async () => {
    if (skipping) return;
    setSkipping(true);
    try {
      // 复用原 API Key 表单的跳过语义，先确认默认运行域，再进入上游启动流程。
      await settingService.update(
        buildLoginApiKeySkipSettings(resolveLoginApiKeyDefaultProvider(locale), Date.now()),
      );
      await onComplete("skip");
    } catch (skipError) {
      toast(
        intl.formatMessage(
          { id: "login.apiKey.skipError" },
          { error: skipError instanceof Error ? skipError.message : String(skipError) },
        ),
        { variant: "warning" },
      );
    } finally {
      setSkipping(false);
    }
  };

  return { skipping, skipLogin };
}
