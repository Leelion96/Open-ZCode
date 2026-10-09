import { PRODUCT_DISPLAY_NAME } from "@zcode/shared/product";

type WebAuthLocale = "zh-CN" | "en-US";

interface WebAuthPageCopy {
  brand: string;
  loginTitle: string;
  loginDescription: string;
  loginAction: string;
  callbackTitle: string;
  callbackDescription: string;
  callbackErrorTitle: string;
  callbackErrorDescription: string;
  retryAction: string;
  waitingTitle: string;
  waitingDescription: string;
  signedInAs: string;
  logoutAction: string;
}

const WEB_AUTH_COPY = {
  "zh-CN": {
    brand: PRODUCT_DISPLAY_NAME,
    loginTitle: "登录后继续使用 Web 远程控制",
    loginDescription: "使用与桌面端一致的 Z.AI 账号身份访问当前远控入口。",
    loginAction: "用 Z.AI 登录",
    callbackTitle: "正在完成登录",
    callbackDescription: "请稍候，正在校验账号身份。",
    callbackErrorTitle: "登录失败",
    callbackErrorDescription: "授权流程未完成，请重新登录。",
    retryAction: "重新登录",
    waitingTitle: "已登录",
    waitingDescription: "设备列表能力即将接入，当前账号暂未选择远控目标。",
    signedInAs: "当前账号",
    logoutAction: "断开连接",
  },
  "en-US": {
    brand: PRODUCT_DISPLAY_NAME,
    loginTitle: "Sign In To Continue",
    loginDescription: "Use the same Z.AI account identity as desktop for Web remote control.",
    loginAction: "Sign in with Z.AI",
    callbackTitle: "Finishing Sign-In",
    callbackDescription: "Verifying your account identity.",
    callbackErrorTitle: "Sign-In Failed",
    callbackErrorDescription: "The authorization flow did not complete. Sign in again.",
    retryAction: "Sign In Again",
    waitingTitle: "Signed In",
    waitingDescription:
      "Device selection is coming next. No remote target is selected for this account yet.",
    signedInAs: "Signed in as",
    logoutAction: "Disconnect",
  },
} satisfies Record<WebAuthLocale, WebAuthPageCopy>;

function resolveWebAuthLocale(language?: string): WebAuthLocale {
  const candidate =
    language ??
    document.documentElement.lang ??
    navigator.language ??
    navigator.languages?.[0] ??
    "";

  return candidate.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function getWebAuthCopy(locale: WebAuthLocale = resolveWebAuthLocale()): WebAuthPageCopy {
  return WEB_AUTH_COPY[locale];
}
