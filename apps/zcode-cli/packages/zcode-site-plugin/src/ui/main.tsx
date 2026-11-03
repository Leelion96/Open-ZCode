import {
  COMMANDS_URI,
  PLANS_URI,
  SITES_URI,
  USAGE_URI,
  type SiteCommand,
  type SitesError,
  type SitesResult,
} from "../contract.ts";
import { createRoot } from "react-dom/client";
import { connectHost, type Route, type SitesHost } from "./host.ts";
import { resolveLocale, translator, type MessageKey } from "./i18n.ts";
import {
  coverKey,
  errorView,
  LOG_POLL_MS,
  pollInterval,
  type Deployment,
  type DeploymentLogs,
  type Page,
  type Plans,
  type Site,
  type SiteCover,
  type Usage,
} from "./model.ts";
import { App, type ViewActions, type ViewState } from "./views.tsx";

const TOAST_MS = 2_500;
const NAME_MAX = 100;

function initialState(route: Route): ViewState {
  return {
    route,
    query: "",
    commands: [],
    logs: [],
    logsDone: false,
    badge: { saving: false },
    covers: {},
  };
}

async function start(): Promise<void> {
  const root = createRoot(document.getElementById("root")!);
  // 握手期间宿主可能先推 hostContext 变化，此时还没有 host，跳过重绘。
  let host: SitesHost | undefined;
  let state = initialState({ page: "list" });
  // 每次换页面或手动刷新 +1；旧页面的在途请求和定时器看到代号变了就丢弃结果。
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let logOffset = 0;

  const render = () => {
    if (!host) return;
    const context = host.context();
    const locale = resolveLocale(context?.locale);
    root.render(
      <App
        state={state}
        view={{ t: translator(locale), locale, timeZone: context?.timeZone, actions }}
      />,
    );
  };
  const update = (patch: Partial<ViewState>) => {
    state = { ...state, ...patch };
    render();
  };

  /** 读失败的统一处理；返回 undefined 表示调用方不要再用这次结果。 */
  const accept = <T,>(result: SitesResult<T>, current: number): T | undefined => {
    if (current !== generation) return undefined;
    if ("data" in result) return result.data;
    const view = errorView(result.error);
    if (view.kind === "page") update({ statusPage: view.key });
    else if (view.kind === "missing") navigate({ page: "list" });
    else
      update({ bar: { key: "sites.error.network", ...(view.logid ? { logid: view.logid } : {}) } });
    return undefined;
  };
  const read = async <T,>(uri: string, current: number) =>
    accept(await host!.read<T>(uri), current);
  const ok = (current: number) => {
    if (current === generation && (state.bar || state.statusPage))
      update({ bar: undefined, statusPage: undefined });
  };

  const schedule = (current: number, ms: number, task: () => Promise<void>) => {
    if (current !== generation) return;
    clearTimeout(timer);
    timer = setTimeout(() => void task(), ms);
  };

  // 正在读的封面（部署 id）；读失败时移出，下一次刷新再试。
  const coverLoads = new Set<string>();
  /** 读这些站点还没缓存的封面。封面按部署 id 缓存，和页面代号无关：换页面后读完的结果照样留着。 */
  function loadCovers(sites: readonly Site[]): void {
    for (const site of sites) {
      const key = coverKey(site);
      if (!key || key in state.covers || coverLoads.has(key)) continue;
      coverLoads.add(key);
      void host!.read<SiteCover | null>(`${SITES_URI}/${site.id}/cover`).then((result) => {
        coverLoads.delete(key);
        if (!("data" in result) || !result.data) return;
        // 读的途中站点又部署了一版时，拿到的是新部署的封面，按它自己的 id 缓存。
        const { deploymentId, contentType, data } = result.data;
        const src = `data:${contentType};base64,${data}`;
        update({ covers: { ...state.covers, [deploymentId]: src } });
      });
    }
  }

  async function loadList(current: number): Promise<void> {
    const sites = await read<Page<Site>>(SITES_URI, current);
    if (!sites)
      return schedule(
        current,
        pollInterval(state.sites?.items.map((s) => s.latestDeployment) ?? []),
        () => loadList(current),
      );
    // 轮询只刷新第一页；已加载的后续页保留，按 id 合并。
    const rest =
      state.sites?.items.filter((site) => !sites.items.some((fresh) => fresh.id === site.id)) ?? [];
    const keepMore = (state.sites?.items.length ?? 0) > sites.items.length;
    update({
      sites: {
        items: [...sites.items, ...(keepMore ? rest : [])],
        nextCursor: keepMore ? state.sites!.nextCursor : sites.nextCursor,
      },
    });
    ok(current);
    loadCovers(state.sites!.items);
    schedule(current, pollInterval(state.sites!.items.map((site) => site.latestDeployment)), () =>
      loadList(current),
    );
  }

  async function loadSite(siteId: string, current: number): Promise<void> {
    const [site, deployments] = await Promise.all([
      read<Site>(`${SITES_URI}/${siteId}`, current),
      read<Page<Deployment>>(`${SITES_URI}/${siteId}/deployments`, current),
    ]);
    if (site && deployments) {
      const more = (state.deployments?.items ?? []).filter(
        (old) => !deployments.items.some((fresh) => fresh.id === old.id),
      );
      const keepMore = (state.deployments?.items.length ?? 0) > deployments.items.length;
      update({
        site,
        deployments: {
          items: [...deployments.items, ...(keepMore ? more : [])],
          nextCursor: keepMore ? state.deployments!.nextCursor : deployments.nextCursor,
        },
      });
      ok(current);
    }
    schedule(current, pollInterval([state.site?.latestDeployment]), () =>
      loadSite(siteId, current),
    );
  }

  async function loadDeployment(
    siteId: string,
    deploymentId: string,
    current: number,
  ): Promise<void> {
    const base = `${SITES_URI}/${siteId}/deployments/${deploymentId}`;
    const [deployment, logs] = await Promise.all([
      read<Deployment>(base, current),
      read<DeploymentLogs>(`${base}/logs?offset=${logOffset}`, current),
    ]);
    if (deployment) update({ deployment });
    if (logs) {
      logOffset = logs.nextOffset;
      update({ logs: [...state.logs, ...logs.entries], logsDone: logs.done });
    }
    if (deployment && logs) ok(current);
    // 日志读完且部署已结束就停；否则 2 秒后按 nextOffset 继续。
    if (
      !(
        logs?.done &&
        deployment &&
        (deployment.status === "success" || deployment.status === "failed")
      )
    )
      schedule(current, LOG_POLL_MS, () => loadDeployment(siteId, deploymentId, current));
  }

  async function loadSiteOnce(siteId: string, current: number): Promise<void> {
    const [site, deployments] = await Promise.all([
      read<Site>(`${SITES_URI}/${siteId}`, current),
      read<Page<Deployment>>(`${SITES_URI}/${siteId}/deployments`, current),
    ]);
    if (site) update({ site });
    if (deployments) update({ deployments });
  }

  async function loadUsage(current: number): Promise<void> {
    const usage = await read<Usage>(USAGE_URI, current);
    if (usage) {
      update({ usage });
      ok(current);
    }
  }

  /**
   * 套餐表只在用量页用，失败不走 accept：它不影响上方用量，就地显示失败，不弹全局错误条。
   * 身份类失败由同时读的用量走状态页。每次进用量页都重读一次，已有的结果先留着显示。
   */
  async function loadPlans(current: number): Promise<void> {
    // 上次失败的话先回到加载态，点重试时有反馈。
    if (state.plans === "failed") update({ plans: undefined });
    const result = await host!.read<Plans>(PLANS_URI);
    if (current !== generation) return;
    if ("data" in result) update({ plans: result.data });
    else if (state.plans === undefined) update({ plans: "failed" });
  }

  async function loadCommands(): Promise<void> {
    const result = await host!.read<SiteCommand[]>(COMMANDS_URI);
    if ("data" in result) update({ commands: result.data });
  }

  function enter(route: Route): void {
    generation += 1;
    const current = generation;
    clearTimeout(timer);
    logOffset = 0;
    if (route.page === "list") {
      void loadList(current);
      void loadUsage(current);
    } else if (route.page === "usage") {
      void loadUsage(current);
      void loadPlans(current);
    } else if (route.page === "site") {
      void loadSite(route.siteId, current);
      // 角标开关要看 badgeRemovable。
      if (!state.usage) void loadUsage(current);
    } else {
      void loadDeployment(route.siteId, route.deploymentId, current);
      // 部署详情页上方仍显示站点头部和标签页，站点只读一次，不跟着日志轮询。
      if (state.site?.id !== route.siteId) void loadSiteOnce(route.siteId, current);
      if (!state.usage) void loadUsage(current);
    }
  }

  function navigate(route: Route): void {
    const sameSite =
      (route.page === "site" || route.page === "deployment") && state.site?.id === route.siteId;
    state = {
      ...initialState(route),
      commands: state.commands,
      usage: state.usage,
      plans: state.plans,
      sites: state.sites,
      ...(sameSite ? { site: state.site, deployments: state.deployments } : {}),
    };
    host!.saveRoute(route);
    render();
    enter(route);
  }

  function toast(key: MessageKey): void {
    clearTimeout(toastTimer);
    update({ toast: translator(resolveLocale(host!.context()?.locale))(key) });
    toastTimer = setTimeout(() => update({ toast: undefined }), TOAST_MS);
  }

  /** 写操作失败时的通用回退：身份与版本问题走状态页，其他就地提示。 */
  function writeFailed(error: SitesError): boolean {
    const view = errorView(error);
    if (view.kind === "page") {
      update({ statusPage: view.key });
      return true;
    }
    if (view.kind === "missing") {
      navigate({ page: "list" });
      return true;
    }
    return false;
  }

  const actions: ViewActions = {
    navigate,
    refresh: () => {
      update({ bar: undefined, statusPage: undefined });
      void loadCommands();
      enter(state.route);
    },
    setQuery: (query) => update({ query }),
    copy: (text, key) =>
      void host!.copy(text).then((copied) => toast(copied ? key : "sites.error.copy")),
    openLink: (url) => host!.openLink(url),
    loadMoreSites: () => {
      const cursor = state.sites?.nextCursor;
      const current = generation;
      if (!cursor) return;
      void read<Page<Site>>(`${SITES_URI}?cursor=${encodeURIComponent(cursor)}`, current).then(
        (page) => {
          if (!page) return;
          update({
            sites: { items: [...state.sites!.items, ...page.items], nextCursor: page.nextCursor },
          });
          loadCovers(page.items);
        },
      );
    },
    loadMoreDeployments: () => {
      const cursor = state.deployments?.nextCursor;
      const site = state.site;
      const current = generation;
      if (!cursor || !site) return;
      void read<Page<Deployment>>(
        `${SITES_URI}/${site.id}/deployments?cursor=${encodeURIComponent(cursor)}`,
        current,
      ).then((page) => {
        if (page)
          update({
            deployments: {
              items: [...state.deployments!.items, ...page.items],
              nextCursor: page.nextCursor,
            },
          });
      });
    },
    startRename: () => update({ rename: { saving: false } }),
    cancelRename: () => update({ rename: undefined }),
    saveRename: (name) => {
      const site = state.site;
      const value = name.trim();
      if (!site || !state.rename) return;
      if (!value || value.length > NAME_MAX)
        return update({ rename: { saving: false, error: "sites.site.nameInvalid" } });
      if (value === site.name) return update({ rename: undefined });
      update({ rename: { saving: true } });
      void host!.renameSite(site.id, value).then((result) => {
        if ("data" in result) {
          update({ rename: undefined, site: result.data as Site });
          return;
        }
        if (writeFailed(result.error)) return;
        const error: MessageKey =
          result.error.code === 3611
            ? "sites.site.nameRejected"
            : result.error.code === 3001
              ? "sites.site.nameInvalid"
              : "sites.error.action";
        update({ rename: { saving: false, error } });
      });
    },
    setBadgeVisible: (visible) => {
      const site = state.site;
      if (!site) return;
      // 先按用户的选择显示，失败时回滚。
      update({ site: { ...site, badgeHidden: !visible }, badge: { saving: true } });
      void host!.setBadgeHidden(site.id, !visible).then((result) => {
        if ("data" in result) {
          update({ site: result.data as Site, badge: { saving: false } });
          return;
        }
        update({ site, badge: { saving: false } });
        if (writeFailed(result.error)) return;
        update({
          badge: {
            saving: false,
            error: result.error.code === 3608 ? "sites.site.badgeRejected" : "sites.error.action",
          },
        });
      });
    },
  };

  const connected = await connectHost(render);
  host = connected;
  state = initialState(connected.initialRoute());
  render();
  void loadCommands();
  enter(state.route);
}

void start();
