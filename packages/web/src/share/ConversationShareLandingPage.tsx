/* eslint-disable max-lines -- share 公开页的状态文案、Row allow-list 和登录态需保持同一安全边界。 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import { ArrowUpRightIcon, MoonIcon, SunIcon } from "lucide-react";
import type { ConversationSharePreview } from "@zcode/shared";
import { PRODUCT_DISPLAY_NAME } from "@zcode/shared/product";
import { ConversationShareReadonlyTimeline } from "@zcode/ui/conversation-share-readonly";
import {
  WebRegionalLoginActions,
  type WebRegionalLoginActionsProps,
} from "#src/auth/WebRegionalLoginActions.js";
import { applyTheme, resolveTheme, type Theme } from "@zcode/ui/useTheme";
import "./conversationShareLandingPage.css";
import {
  buildShareImportDeepLink,
  type ConversationSharePreviewClientError,
  type ConversationSharePreviewErrorKind,
} from "./conversationSharePreviewClient.js";
import { resolveShareHeaderView, type ShareHeaderView } from "./shareHeaderLayout.js";

export type ConversationShareLandingLocale = "zh-CN" | "en-US";
export type ConversationShareLandingState =
  | { kind: "loading" }
  | { kind: "login_required" }
  | { kind: "ready"; preview: ConversationSharePreview }
  | {
      kind: "error";
      error: ConversationSharePreviewErrorKind;
      status?: number;
      code?: number;
      requestId?: string;
    };

function logPreviewLoadFailure(
  stage: "anonymous" | "authenticated",
  error: unknown,
  kind: ConversationSharePreviewErrorKind,
): void {
  const clientError = error as Partial<ConversationSharePreviewClientError> | null;
  console.warn("[conversation-share-web]", "preview_load_failed", {
    stage,
    kind,
    errorName: error instanceof Error ? error.name : typeof error,
    status: typeof clientError?.status === "number" ? clientError.status : undefined,
    code: typeof clientError?.code === "number" ? clientError.code : undefined,
  });
}

interface Copy {
  brand: string;
  loading: string;
  loadingDescription: string;
  loginTitle: string;
  loginDescription: string;
  login: string;
  /** 每个 provider 的登录按钮文案与区域徽标，对齐桌面端 login.oauth.* 口径。 */
  expiredTitle: string;
  expiredDescription: string;
  revokedTitle: string;
  revokedDescription: string;
  manageShares: string;
  notFoundTitle: string;
  notFoundDescription: string;
  notFoundAccountHint: string;
  backToHome: string;
  rateLimitedTitle: string;
  rateLimitedDescription: string;
  serviceUnavailableTitle: string;
  serviceUnavailableDescription: string;
  featureDisabledTitle: string;
  featureDisabledDescription: string;
  errorDetails: string;
  requestId: string;
  errorCode: string;
  networkTitle: string;
  networkDescription: string;
  invalidTitle: string;
  invalidDescription: string;
  outdatedTitle: string;
  outdatedDescription: string;
  unavailableTitle: string;
  unavailableDescription: string;
  retry: string;
  continueInZCode: string;
  switchToDarkTheme: string;
  switchToLightTheme: string;
  continueHelp: string;
  downloadZCode: string;
  retryOpen: string;
  /** 结果物计数；{count} 占位。中文无复数，英文分单复数。 */
  artifactCountOne: string;
  artifactCountOther: string;
}

// TODO: 补充自有客户端的下载地址。
const ZCODE_DOWNLOAD_URL = "";

// 品牌与外部打开目标使用配置名称；升级、下载和打开失败说明只需指明客户端/应用。
const COPY: Record<ConversationShareLandingLocale, Copy> = {
  "zh-CN": {
    brand: `${PRODUCT_DISPLAY_NAME} 会话分享`,
    loading: "正在加载分享内容",
    loadingDescription: "请稍候，我们正在验证分享链接。",
    loginTitle: "登录后查看分享",
    loginDescription: "请登录后确认你是否有权限查看这个分享。",
    login: "登录",
    expiredTitle: "分享已过期",
    expiredDescription: "这个分享链接已经过期，请让分享者重新生成链接。",
    revokedTitle: "分享已撤销",
    revokedDescription: "分享者已撤销这个链接。如需查看，请让分享者重新分享。",
    manageShares: "管理我的分享",
    notFoundTitle: "找不到分享内容",
    notFoundDescription: "链接可能无效、分享已被移除，或当前登录账号无法访问。",
    notFoundAccountHint: "请确认所选区域和账号与分享者授予访问权限的账号一致。",
    backToHome: "回到首页",
    rateLimitedTitle: "访问过于频繁",
    rateLimitedDescription: "请稍后重试。",
    serviceUnavailableTitle: "分享服务暂时异常",
    serviceUnavailableDescription: "请稍后重试；若仍失败，请提供错误详情。",
    featureDisabledTitle: "分享服务暂未开放",
    featureDisabledDescription: "请稍后再试。",
    errorDetails: "错误详情",
    requestId: "服务端请求 ID",
    errorCode: "错误码",
    networkTitle: "暂时无法加载分享",
    networkDescription: "请检查网络后重试。",
    invalidTitle: "无法读取分享内容",
    invalidDescription: "分享服务返回了无法识别的数据，请提供错误详情。",
    outdatedTitle: "需要更新客户端",
    outdatedDescription: "这个分享由更新版本的客户端创建，请升级后再查看。",
    unavailableTitle: "分享不可访问",
    unavailableDescription: "当前账号没有权限，或者分享内容已不存在。",
    retry: "重试",
    continueInZCode: `去 ${PRODUCT_DISPLAY_NAME} 继续`,
    switchToDarkTheme: "切换到深色主题",
    switchToLightTheme: "切换到浅色主题",
    continueHelp: "如果没有自动打开应用，请确认已安装客户端，然后重试。",
    downloadZCode: "下载客户端",
    artifactCountOne: "{count} 个结果物",
    artifactCountOther: "{count} 个结果物",
    retryOpen: "再次打开",
  },
  "en-US": {
    brand: `${PRODUCT_DISPLAY_NAME} Conversation Share`,
    loading: "Loading shared conversation",
    loadingDescription: "Please wait while we verify this share link.",
    loginTitle: "Sign in to view this share",
    loginDescription: "Sign in to check whether you can view this shared conversation.",
    login: "Sign in",
    expiredTitle: "Share expired",
    expiredDescription: "This share link has expired. Ask the author to create a new one.",
    revokedTitle: "Share revoked",
    revokedDescription: "The author revoked this link. Ask them to share it again.",
    manageShares: "Manage my shares",
    notFoundTitle: "Share not found",
    notFoundDescription:
      "The link may be invalid, the share may have been removed, or your current account may not have access.",
    notFoundAccountHint:
      "Check that your account and region match the account granted access by the author.",
    backToHome: "Back to home",
    rateLimitedTitle: "Too many requests",
    rateLimitedDescription: "Try again later.",
    serviceUnavailableTitle: "Sharing service unavailable",
    serviceUnavailableDescription: "Try again later. If this persists, provide the error details.",
    featureDisabledTitle: "Sharing is currently unavailable",
    featureDisabledDescription: "Try again later.",
    errorDetails: "Error details",
    requestId: "Server request ID",
    errorCode: "Error code",
    networkTitle: "Unable to load share",
    networkDescription: "Check your network connection and try again.",
    invalidTitle: "Unable to read shared content",
    invalidDescription:
      "The sharing service returned unrecognized data. Provide the error details.",
    outdatedTitle: "Update the app to continue",
    outdatedDescription:
      "This share was created by a newer app version. Please update to view it.",
    unavailableTitle: "Share unavailable",
    unavailableDescription:
      "This account is not allowed to view the share, or it no longer exists.",
    retry: "Try again",
    continueInZCode: `Continue in ${PRODUCT_DISPLAY_NAME}`,
    switchToDarkTheme: "Switch to dark theme",
    switchToLightTheme: "Switch to light theme",
    continueHelp: "If the app did not open, make sure it is installed and try again.",
    downloadZCode: "Download the app",
    artifactCountOne: "{count} artifact",
    artifactCountOther: "{count} artifacts",
    retryOpen: "Try again",
  },
};

function localeOf(locale?: ConversationShareLandingLocale): ConversationShareLandingLocale {
  if (locale) return locale;
  return /^zh(?:-|$)/iu.test(globalThis.navigator?.language ?? "") ? "zh-CN" : "en-US";
}

function formatDate(timestamp: number, locale: ConversationShareLandingLocale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(timestamp),
  );
}

const SHARE_CONTENT_RAIL_CLASS =
  "@container/conversation mx-auto w-full max-w-4xl px-4 sm:px-8 xl:max-w-6xl";
const SHARE_CONTINUE_LINK_CLASS =
  "inline-flex max-w-full items-center gap-2 rounded-xl bg-primary px-4 py-2 text-ui-base font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/80 focus-visible:ring-2 focus-visible:ring-input-border-focused sm:gap-3 sm:px-5 sm:py-2.5";
const SHARE_CONTINUE_MEASURE_CLASS =
  "inline-flex max-w-none items-center gap-2 rounded-xl bg-primary px-4 py-2 text-ui-base font-medium text-primary-foreground sm:gap-3 sm:px-5 sm:py-2.5";
const SHARE_CONTINUE_COMPACT_CLASS =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm transition-colors hover:bg-primary/80 focus-visible:ring-2 focus-visible:ring-input-border-focused";
const SHARE_THEME_TOGGLE_CLASS =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused";

export function ShareThemeToggle({
  theme,
  copy,
  onThemeChange,
}: {
  theme: Theme;
  copy: Pick<Copy, "switchToDarkTheme" | "switchToLightTheme">;
  onThemeChange?: (theme: Theme) => void;
}) {
  const resolvedTheme = resolveTheme(theme);
  const nextTheme = resolvedTheme === "dark" ? "zai-light" : "zai-dark";
  const label = resolvedTheme === "dark" ? copy.switchToLightTheme : copy.switchToDarkTheme;
  const Icon = resolvedTheme === "dark" ? SunIcon : MoonIcon;

  return (
    <button
      type="button"
      data-share-theme-toggle="true"
      className={SHARE_THEME_TOGGLE_CLASS}
      aria-label={label}
      title={label}
      onClick={() => onThemeChange?.(nextTheme)}
    >
      <Icon className="size-4" aria-hidden="true" />
    </button>
  );
}

/** 应用图标 + 字标。分享落地页与分享管理页共用，定位由各自的外层容器决定。 */
export function ShareBrandMark() {
  return (
    <>
      <span data-share-brand-icon="true" aria-hidden="true">
        <svg viewBox="0 0 256 218" fill="currentColor" focusable="false">
          <path d="M134.4 0.130152L116.48 25.6022C113.665 29.5699 109.054 32.0019 104.064 32.0019H6.3999V0C6.3999 0.130149 134.4 0.130152 134.4 0.130152Z" />
          <path d="M256 0.130127L102.401 217.732H0L153.599 0.130127H256Z" />
          <path d="M121.601 217.732L139.65 192.134C142.465 188.166 147.076 185.734 152.067 185.734H249.604V217.736H121.601V217.732Z" />
        </svg>
      </span>
      <span data-share-brand-wordmark="true" className="text-ui-lg font-semibold">
        {PRODUCT_DISPLAY_NAME}
      </span>
    </>
  );
}

function ShareContentRail({
  children,
  className = "",
  body = false,
}: {
  children: React.ReactNode;
  className?: string;
  body?: boolean;
}) {
  return (
    <div
      data-share-content-rail="true"
      data-share-body-rail={body ? "true" : undefined}
      className={`${SHARE_CONTENT_RAIL_CLASS} ${className}`}
    >
      {children}
    </div>
  );
}

function ShareContentInset({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-share-content-inset="true"
      className={`w-full px-4 @md/conversation:px-6 ${className}`}
    >
      {children}
    </div>
  );
}

export function ConversationShareLandingPage({
  shareCode,
  preview,
  locale,
  theme,
  onThemeChange,
  manageHref,
}: {
  shareCode: string;
  preview: ConversationSharePreview;
  locale?: ConversationShareLandingLocale;
  theme?: Theme;
  onThemeChange?: (theme: Theme) => void;
  /** 已登录时显示「管理我的分享」入口；放在元信息行，不改变顶部栏的连续几何轨道。 */
  manageHref?: string;
}) {
  const resolvedLocale = localeOf(locale);
  const copy = COPY[resolvedLocale];
  const activeTheme = theme ?? "zai-light";
  // preview 到手后把会话标题写进浏览器标签；main.tsx 只能先给一个语言正确的兜底标题。
  const shareTitle = preview.share.title;
  useEffect(() => {
    document.title = `${shareTitle} · ${copy.brand}`;
  }, [copy.brand, shareTitle]);
  const [showContinueHelp, setShowContinueHelp] = useState(false);
  const importLink =
    preview.share.access_mode === "public_importable" || preview.share.access_mode === "private"
      ? buildShareImportDeepLink(shareCode)
      : null;
  // 结果物数量只统计时间线实际展示的 artifact Row；preview.artifacts 还包含 userInput
  // 附件的下载 manifest，不能直接拿 manifest 数量当作结果物数量。
  const artifactCount = preview.rows.filter((row) => row.kind === "artifact").length;
  const artifactCountLabel = (
    artifactCount === 1 ? copy.artifactCountOne : copy.artifactCountOther
  ).replace("{count}", String(artifactCount));
  const artifactUrls = new Map(
    preview.artifacts.map((artifact) => [artifact.artifact_id, artifact.url]),
  );
  const artifactNames = new Map(
    preview.artifacts.map((artifact) => [artifact.artifact_id, artifact.display_name]),
  );
  const headerRowRef = useRef<HTMLDivElement>(null);
  const headerShellRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleMeasureRef = useRef<HTMLSpanElement>(null);
  const continueMeasureRef = useRef<HTMLSpanElement>(null);
  const compactContinueMeasureRef = useRef<HTMLSpanElement>(null);
  const [headerMeasured, setHeaderMeasured] = useState(false);
  const [headerView, setHeaderView] = useState<ShareHeaderView>({
    progress: 0,
    brandLeft: 0,
    titleLeft: 0,
    titleWidth: 0,
    continueRight: 0,
    titleTruncated: false,
    continueVisible: Boolean(importLink),
    continueCompact: false,
  });

  useLayoutEffect(() => {
    const row = headerRowRef.current;
    if (!row) return;
    const updateLayout = () => {
      const rowRect = row.getBoundingClientRect();
      const shellRect = headerShellRef.current?.getBoundingClientRect();
      if (!shellRect) return;
      const nextView = resolveShareHeaderView({
        shellWidth: shellRect.width,
        railContentLeft: rowRect.left - shellRect.left,
        railContentRight: shellRect.right - rowRect.right,
        brandWidth: brandRef.current?.getBoundingClientRect().width ?? 50,
        titleContentWidth: titleMeasureRef.current?.getBoundingClientRect().width ?? 0,
        continueWidth: continueMeasureRef.current?.getBoundingClientRect().width ?? 0,
        compactContinueWidth: compactContinueMeasureRef.current?.getBoundingClientRect().width ?? 0,
        hasContinueAction: Boolean(importLink),
      });
      setHeaderMeasured(true);
      setHeaderView((current) =>
        current.progress === nextView.progress &&
        current.brandLeft === nextView.brandLeft &&
        current.titleLeft === nextView.titleLeft &&
        current.titleWidth === nextView.titleWidth &&
        current.continueRight === nextView.continueRight &&
        current.titleTruncated === nextView.titleTruncated &&
        current.continueVisible === nextView.continueVisible &&
        current.continueCompact === nextView.continueCompact
          ? current
          : nextView,
      );
    };
    updateLayout();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateLayout);
    observer.observe(row);
    if (headerShellRef.current) observer.observe(headerShellRef.current);
    if (brandRef.current) observer.observe(brandRef.current);
    if (titleRef.current) observer.observe(titleRef.current);
    if (titleMeasureRef.current) observer.observe(titleMeasureRef.current);
    if (continueMeasureRef.current) observer.observe(continueMeasureRef.current);
    if (compactContinueMeasureRef.current) observer.observe(compactContinueMeasureRef.current);
    return () => observer.disconnect();
  }, [resolvedLocale, importLink]);

  const headerGeometryStyle = {
    "--share-brand-left": `${headerView.brandLeft}px`,
    "--share-title-left": `${headerView.titleLeft}px`,
    "--share-title-width": `${headerView.titleWidth}px`,
    "--share-continue-right": `${headerView.continueRight}px`,
  } as CSSProperties;

  const handleContinue = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      setShowContinueHelp(false);
      window.location.href = importLink!;
      window.setTimeout(() => {
        if (document.visibilityState === "visible") {
          setShowContinueHelp(true);
        }
      }, 1500);
    },
    [importLink],
  );

  return (
    <main
      className="h-full min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain bg-background text-foreground [scrollbar-gutter:stable]"
      data-markdown-table-layout-root="true"
      data-share-scroll-viewport="true"
    >
      <header
        data-share-header="true"
        className="sticky top-0 z-20 border-b border-border bg-background backdrop-blur"
      >
        <div
          ref={headerShellRef}
          data-share-header-shell="true"
          data-share-header-layout="continuous"
          data-share-header-ready={headerMeasured ? "true" : "false"}
          className="w-full"
          style={headerGeometryStyle}
        >
          <ShareContentRail className="flex h-16 items-center">
            <ShareContentInset>
              <div
                ref={headerRowRef}
                data-share-header-row="true"
                className="h-full w-full min-w-0"
              >
                <div
                  ref={brandRef}
                  data-share-brand="true"
                  className="flex shrink-0 items-center gap-2 text-foreground"
                  aria-label={PRODUCT_DISPLAY_NAME}
                >
                  <ShareBrandMark />
                </div>
                <h1
                  ref={titleRef}
                  data-share-title="true"
                  data-share-title-truncated={headerView.titleTruncated ? "true" : "false"}
                  className="truncate text-left text-ui-lg font-medium"
                  title={preview.share.title}
                >
                  {preview.share.title}
                </h1>
                <span
                  ref={titleMeasureRef}
                  data-share-title-measure="true"
                  className="text-ui-lg font-medium"
                  aria-hidden="true"
                >
                  {preview.share.title}
                </span>
                <div
                  data-share-continue-slot="true"
                  data-share-continue-visible={
                    importLink && headerView.continueVisible ? "true" : "false"
                  }
                >
                  <div className="flex items-center gap-2">
                    <ShareThemeToggle
                      theme={activeTheme}
                      copy={copy}
                      onThemeChange={onThemeChange}
                    />
                    {importLink && headerView.continueVisible ? (
                      <a
                        data-share-continue-link="true"
                        data-share-continue-compact={headerView.continueCompact ? "true" : "false"}
                        className={
                          headerView.continueCompact
                            ? SHARE_CONTINUE_COMPACT_CLASS
                            : SHARE_CONTINUE_LINK_CLASS
                        }
                        href={importLink}
                        aria-label={copy.continueInZCode}
                        title={copy.continueInZCode}
                        onClick={handleContinue}
                      >
                        <span className={headerView.continueCompact ? "sr-only" : "truncate"}>
                          {copy.continueInZCode}
                        </span>
                        <ArrowUpRightIcon
                          className={
                            headerView.continueCompact
                              ? "size-4 shrink-0"
                              : "size-4 shrink-0 sm:size-5"
                          }
                          aria-hidden="true"
                        />
                      </a>
                    ) : null}
                  </div>
                  <span
                    ref={continueMeasureRef}
                    data-share-continue-measure="true"
                    className="inline-flex items-center gap-2"
                    aria-hidden="true"
                    tabIndex={-1}
                  >
                    <span className={SHARE_THEME_TOGGLE_CLASS}>
                      <MoonIcon className="size-4" aria-hidden="true" />
                    </span>
                    {importLink ? (
                      <span className={SHARE_CONTINUE_MEASURE_CLASS}>
                        <span>{copy.continueInZCode}</span>
                        <ArrowUpRightIcon
                          className="size-4 shrink-0 sm:size-5"
                          aria-hidden="true"
                        />
                      </span>
                    ) : null}
                  </span>
                  <span
                    ref={compactContinueMeasureRef}
                    data-share-continue-compact-measure="true"
                    className="inline-flex items-center gap-2"
                    aria-hidden="true"
                    tabIndex={-1}
                  >
                    <span className={SHARE_THEME_TOGGLE_CLASS}>
                      <MoonIcon className="size-4" aria-hidden="true" />
                    </span>
                    {importLink ? (
                      <span className={SHARE_CONTINUE_COMPACT_CLASS}>
                        <ArrowUpRightIcon className="size-4" aria-hidden="true" />
                      </span>
                    ) : null}
                  </span>
                </div>
              </div>
            </ShareContentInset>
          </ShareContentRail>
        </div>
      </header>

      <ShareContentRail body className="py-6 sm:py-10">
        <ShareContentInset>
          <div
            data-share-metadata="true"
            className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm text-foreground-subtle"
          >
            <span>{formatDate(preview.share.created_at, resolvedLocale)}</span>
            {artifactCount ? (
              // 这里原本硬编码英文 artifact/artifacts 且手写复数，中文页会渲染成
              // 「2026年9月3日 11:55 · 1 artifact」这种中英混排。
              <span aria-label={artifactCountLabel}>· {artifactCountLabel}</span>
            ) : null}
            {manageHref ? (
              <a
                data-share-manage-link="true"
                className="ml-auto text-brand underline-offset-2 hover:underline"
                href={manageHref}
              >
                {copy.manageShares}
              </a>
            ) : null}
          </div>
        </ShareContentInset>
        {importLink && showContinueHelp ? (
          // 这块原本是 ShareContentRail 的直接子元素，没套 ShareContentInset，
          // 因此缺了 inset 的 px-4 / @md:px-6，横幅比上方时间行和下方正文都宽出一截。
          <ShareContentInset>
            <div
              className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-ui-sm text-foreground-subtle"
              role="status"
            >
              <span>{copy.continueHelp}</span>
              <a
                className="text-brand underline underline-offset-2"
                href={importLink}
                onClick={handleContinue}
              >
                {copy.retryOpen}
              </a>
              {ZCODE_DOWNLOAD_URL ? (
                <a className="text-brand underline underline-offset-2" href={ZCODE_DOWNLOAD_URL}>
                  {copy.downloadZCode}
                </a>
              ) : null}
            </div>
          </ShareContentInset>
        ) : null}
        <ConversationShareReadonlyTimeline
          rows={preview.rows}
          contentBlocks={preview.content_blocks}
          unsupportedRowCount={preview.unsupportedRowCount}
          locale={resolvedLocale}
          theme={theme}
          artifactUrls={artifactUrls}
          artifactNames={artifactNames}
        />
        {importLink ? (
          <ShareContentInset>
            <div
              data-share-continue-footer="true"
              className="flex justify-center pb-2 pt-8 sm:pt-10"
            >
              <a
                data-share-continue-link="true"
                className={SHARE_CONTINUE_LINK_CLASS}
                href={importLink}
                onClick={handleContinue}
              >
                <span className="truncate">{copy.continueInZCode}</span>
                <ArrowUpRightIcon className="size-4 shrink-0 sm:size-5" aria-hidden="true" />
              </a>
            </div>
          </ShareContentInset>
        ) : null}
      </ShareContentRail>
    </main>
  );
}

export function ConversationShareLandingStatus({
  state,
  locale,
  onLogin,
  onRetry,
  loginCopy,
}: {
  state: Exclude<ConversationShareLandingState, { kind: "ready" }>;
  locale?: ConversationShareLandingLocale;
  onLogin?: WebRegionalLoginActionsProps["onLogin"];
  onRetry?: () => void;
  /** 管理页复用同一登录卡片，只替换标题与说明。 */
  loginCopy?: { title: string; description: string };
}) {
  const copy = COPY[localeOf(locale)];
  const content =
    state.kind === "loading"
      ? { title: copy.loading, description: copy.loadingDescription }
      : state.kind === "login_required"
        ? (loginCopy ?? { title: copy.loginTitle, description: copy.loginDescription })
        : state.error === "rate_limited"
          ? { title: copy.rateLimitedTitle, description: copy.rateLimitedDescription }
          : state.error === "feature_disabled"
            ? { title: copy.featureDisabledTitle, description: copy.featureDisabledDescription }
            : state.error === "service_unavailable" || state.error === "unknown"
              ? {
                  title: copy.serviceUnavailableTitle,
                  description: copy.serviceUnavailableDescription,
                }
              : state.error === "expired"
                ? { title: copy.expiredTitle, description: copy.expiredDescription }
                : state.error === "revoked"
                  ? { title: copy.revokedTitle, description: copy.revokedDescription }
                  : state.error === "not_found"
                    ? { title: copy.notFoundTitle, description: copy.notFoundDescription }
                    : state.error === "unsupported_schema_version"
                      ? { title: copy.outdatedTitle, description: copy.outdatedDescription }
                      : state.error === "invalid_contract"
                        ? { title: copy.invalidTitle, description: copy.invalidDescription }
                        : state.error === "authentication_required"
                          ? { title: copy.loginTitle, description: copy.loginDescription }
                          : { title: copy.networkTitle, description: copy.networkDescription };
  const showLogin =
    state.kind === "login_required" ||
    (state.kind === "error" && state.error === "authentication_required");
  const isNotFound = state.kind === "error" && state.error === "not_found";
  /**
   * 只在「重发同一个请求有可能得到不同结果」时给重试。
   *
   * 需要登录时该做的是登录，重发未授权请求结果不变；已过期不会自己变回未过期；载荷版本
   * 高于本 build 得升级客户端。这几种给重试等于给一个必然无效的动作。
   */
  const canRetry =
    Boolean(onRetry) &&
    state.kind !== "loading" &&
    !showLogin &&
    !(
      state.kind === "error" &&
      (state.error === "expired" ||
        state.error === "revoked" ||
        state.error === "unsupported_schema_version" ||
        state.error === "feature_disabled" ||
        state.error === "not_found" ||
        state.error === "invalid_contract")
    );
  return (
    <main className="flex h-full min-h-0 items-center justify-center overflow-y-auto bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-md rounded-lg border border-card-border bg-card p-6 shadow-sm">
        <div className="mb-4 text-ui-sm font-medium text-brand">{copy.brand}</div>
        <h1 className="text-ui-xl font-semibold">{content.title}</h1>
        <p className="mt-3 text-ui-base leading-6 text-foreground-subtle">{content.description}</p>
        {state.kind === "error" &&
        (state.status !== undefined || state.code !== undefined || state.requestId) ? (
          <details className="mt-4 text-ui-xs text-foreground-subtle">
            <summary className="cursor-pointer">{copy.errorDetails}</summary>
            {[
              ["HTTP", state.status],
              [copy.errorCode, state.code],
              [copy.requestId, state.requestId],
            ].map(([label, value]) =>
              value === undefined ? null : (
                <p key={label} className="mt-1 break-all select-text">
                  {label}: {value}
                </p>
              ),
            )}
          </details>
        ) : null}
        {/* 服务端会隐匿无权限分享的存在性，账号提示仅作排查建议，不能断言用户登录错了。 */}
        {isNotFound ? (
          <p className="mt-4 text-ui-base leading-6 text-foreground-subtle">
            {copy.notFoundAccountHint}
          </p>
        ) : null}
        {showLogin && onLogin ? (
          <div className="mt-5">
            <WebRegionalLoginActions onLogin={onLogin} locale={locale} />
          </div>
        ) : null}
        {canRetry || (isNotFound && ZCODE_DOWNLOAD_URL) ? (
          <div className="mt-5 flex flex-wrap gap-2">
            {canRetry ? (
              <button
                type="button"
                className="rounded-md border border-border px-4 py-2 text-ui-base text-foreground"
                onClick={onRetry}
              >
                {copy.retry}
              </button>
            ) : null}
            {isNotFound && ZCODE_DOWNLOAD_URL ? (
              <a
                className="rounded-md bg-primary px-4 py-2 text-ui-base text-primary-foreground"
                href={ZCODE_DOWNLOAD_URL}
              >
                {copy.backToHome}
              </a>
            ) : null}
          </div>
        ) : null}
      </section>
    </main>
  );
}

export function ConversationShareLandingLoader({
  shareCode,
  client,
  getAccessToken,
  onLogin,
  onLogout,
  locale,
  theme,
  manageHref,
}: {
  shareCode: string;
  client: {
    getPreview: (shareCode: string, accessToken?: string) => Promise<ConversationSharePreview>;
  };
  getAccessToken?: () => string | null;
  onLogin?: WebRegionalLoginActionsProps["onLogin"];
  onLogout?: () => void;
  locale?: ConversationShareLandingLocale;
  theme?: Theme;
  manageHref?: string;
}) {
  const [state, setState] = useState<ConversationShareLandingState>({ kind: "loading" });
  const [activeTheme, setActiveTheme] = useState<Theme>(theme ?? "zai-light");
  const handleThemeChange = useCallback((nextTheme: Theme) => {
    localStorage.setItem("zcode-theme", nextTheme);
    setActiveTheme(nextTheme);
    applyTheme(nextTheme);
  }, []);
  useEffect(() => {
    if (activeTheme !== "system") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = () => applyTheme("system");
    mediaQuery.addEventListener("change", handleSystemThemeChange);
    return () => mediaQuery.removeEventListener("change", handleSystemThemeChange);
  }, [activeTheme]);
  const load = useCallback(async () => {
    setState({ kind: "loading" });
    // 有登录态就第一次直接带上：private 分享匿名请求必然被服务端按存在性隐匿判 404，
    // 先发一次注定失败的匿名请求只是白跑一个往返。没有登录态时仍然匿名试——公开分享
    // 不需要登录，不能因为没 token 就先弹登录。
    const initialToken = getAccessToken?.() ?? null;
    try {
      const preview = await client.getPreview(shareCode, initialToken ?? undefined);
      setState({ kind: "ready", preview });
    } catch (error) {
      const kind =
        error && typeof error === "object" && "kind" in error
          ? (error as ConversationSharePreviewClientError).kind
          : "network";
      const failure = error as Partial<ConversationSharePreviewClientError> | null;
      const diagnostics = {
        status: failure?.status,
        code: failure?.code,
        requestId: failure?.requestId,
      };
      logPreviewLoadFailure(initialToken ? "authenticated" : "anonymous", error, kind);
      if (kind === "authentication_required" || kind === "not_found") {
        // 带过 token 还失败就没有第二次机会了：要么本地登录态已失效（让宿主清理并重新登录），
        // 要么服务端确实不认这个访问者。
        if (initialToken) {
          setState({ kind: "error", error: kind, ...diagnostics });
          if (kind === "authentication_required") onLogout?.();
          return;
        }
        setState({ kind: "login_required" });
        return;
      }
      setState({ kind: "error", error: kind, ...diagnostics });
    }
  }, [client, getAccessToken, onLogout, shareCode]);
  useEffect(() => {
    void load();
  }, [load]);
  if (state.kind === "ready")
    return (
      <ConversationShareLandingPage
        shareCode={shareCode}
        preview={state.preview}
        locale={locale}
        theme={activeTheme}
        onThemeChange={handleThemeChange}
        manageHref={getAccessToken?.() ? manageHref : undefined}
      />
    );
  return (
    <ConversationShareLandingStatus
      state={state}
      locale={locale}
      onLogin={onLogin}
      onRetry={() => void load()}
    />
  );
}
