import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";
import type { ISettingService } from "@zcode/services";
import { USER_INSTRUCTIONS_MAX_BYTES } from "@zcode/shared";
import {
  TID_SETTINGS_PERSONALIZATION_CANCEL,
  TID_SETTINGS_PERSONALIZATION_EDITOR,
  TID_SETTINGS_PERSONALIZATION_SAVE,
  TID_SETTINGS_PERSONALIZATION_SIZE_HINT,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { logger } from "@/logger.js";

type PersonalizationSettingService = Pick<
  ISettingService,
  "getUserInstructions" | "saveUserInstructions"
>;

function countUtf8Bytes(content: string): number {
  return new TextEncoder().encode(content).length;
}

function formatKb(bytes: number): string {
  return `${Math.ceil(bytes / 1024)} KB`;
}

/**
 * 个性化表单状态收口在组件外的模块级 store（评审 CR：保存中切走分区时组件卸载，
 * state 里的草稿没有存活 owner，写入失败后既不能重试也不能复制）。
 * - 卸载不失活：重进分区恢复草稿与失败态，兑现「保存失败草稿仍在编辑器」的承诺；
 * - 双层失效边界：generation 绑定服务实例（Host 连接）身份，实例变化（Web 远控
 *   切换桌面/重连）时整体重置，旧连接的在途回调失效，避免把 A 桌面的草稿带到
 *   B 桌面（文件路径不是跨机器身份）；loadRequestId 标记每次读取，迟到的旧读取
 *   （新读取已开始或保存已发生后才返回）不得覆盖新草稿与基线——服务连接版本与
 *   读取请求版本是不同的时序边界。
 */
interface PersonalizationDraftState {
  generation: number;
  loadRequestId: number;
  boundService: object | null;
  readState: "loading" | "ready" | "error";
  baseline: string;
  draft: string;
  saving: boolean;
  filePath: string | null;
  beginLoad: (service: object) => { generation: number; requestId: number };
  markLoadSuccess: (
    result: { content: string; filePath: string },
    generation: number,
    requestId: number,
  ) => void;
  markLoadError: (generation: number, requestId: number) => void;
  setDraft: (content: string) => void;
  beginSave: (generation: number) => void;
  endSaveSuccess: (content: string, generation: number) => void;
  endSaveFailure: (generation: number) => void;
}

const usePersonalizationDraftStore = create<PersonalizationDraftState>((set, get) => ({
  generation: 0,
  loadRequestId: 0,
  boundService: null,
  readState: "loading",
  baseline: "",
  draft: "",
  saving: false,
  filePath: null,
  beginLoad: (service) => {
    set((state) => ({
      ...(state.boundService === service
        ? state
        : {
            generation: state.generation + 1,
            boundService: service,
            readState: "loading" as const,
            baseline: "",
            draft: "",
            saving: false,
            filePath: null,
          }),
      loadRequestId: state.loadRequestId + 1,
    }));
    return { generation: get().generation, requestId: get().loadRequestId };
  },
  markLoadSuccess: (result, generation, requestId) =>
    set((state) => {
      if (state.generation !== generation || state.loadRequestId !== requestId) return state;
      // 文件未被外部改过（仍等于基线）且草稿有待保存修改时续用草稿；
      // 文件已变化（外部/其他设备写入）时文件优先。
      const resumeDraft = state.draft !== state.baseline && result.content === state.baseline;
      return {
        readState: "ready",
        filePath: result.filePath,
        baseline: result.content,
        draft: resumeDraft ? state.draft : result.content,
        saving: state.saving,
      };
    }),
  markLoadError: (generation, requestId) =>
    set((state) =>
      state.generation !== generation || state.loadRequestId !== requestId
        ? state
        : { readState: "error", saving: false },
    ),
  setDraft: (content) => set({ draft: content }),
  // 保存同时使在途读取失效：读取响应可能晚于保存落盘返回，其内容是旧快照，
  // 应用它会用旧内容覆盖已保存的新基线与草稿。
  beginSave: (generation) =>
    set((state) =>
      state.generation !== generation
        ? state
        : { saving: true, loadRequestId: state.loadRequestId + 1 },
    ),
  endSaveSuccess: (content, generation) =>
    set((state) =>
      state.generation !== generation ? state : { saving: false, baseline: content },
    ),
  endSaveFailure: (generation) =>
    set((state) => (state.generation !== generation ? state : { saving: false })),
}));

/**
 * 个性化（用户自定义指令）编辑页，单层直达：标题（框架渲染）→ 说明 → 直接铺在页面上的编辑器。
 * 唯一事实源是 `~/.zcode/AGENTS.md`（CLI 用户级默认指令，注入所有会话）。
 * 仅桌面本地入口渲染编辑器（Web 远控给本地端指引，不发起任何读写）。
 * 显式「保存/取消」：保存仅脏态且未超限可用，取消丢弃修改恢复基线；Ctrl/Cmd+S 等价保存。
 * 表单状态在模块级 store，保存中切走分区后写入失败草稿仍可恢复重试。
 * 读取成功前禁用编辑（失败给重试入口）；内容超过 Agent 读取上限（100KB）时阻断保存并提示。
 * spec 见 docs/ui/settings-personalization.md。
 */
export function PersonalizationSection({
  settingService,
  isDesktop = false,
}: {
  settingService: PersonalizationSettingService;
  /** 仅桌面本地入口可编辑：手机远控的 base services 可能归属远程 Source
   *（remoteWorkspaceServiceCollection 把远程 Source 的 settingService 注册进该
   * workspace 的服务集合，文件路径不是跨机器身份），编辑会写错机器。 */
  isDesktop?: boolean;
}) {
  // Web 远控不发起任何个性化读写，只给本地桌面端指引（同 WorkspaceFileSearchSection
  // 的无 workspace 分层先例：提前返回，不挂服务解析 hook 链）。
  if (!isDesktop) {
    return <LocalOnlyPersonalizationHint />;
  }
  return <DesktopPersonalizationEditor settingService={settingService} />;
}

function LocalOnlyPersonalizationHint() {
  const { intl } = useZCodeIntl();
  return (
    <p className="text-ui-base leading-6 text-foreground-subtle">
      {intl.formatMessage({ id: "settings.personalization.localOnly" })}
    </p>
  );
}

function DesktopPersonalizationEditor({
  settingService,
}: {
  settingService: PersonalizationSettingService;
}) {
  const { intl } = useZCodeIntl();
  const readState = usePersonalizationDraftStore((state) => state.readState);
  const baseline = usePersonalizationDraftStore((state) => state.baseline);
  const draft = usePersonalizationDraftStore((state) => state.draft);
  const saving = usePersonalizationDraftStore((state) => state.saving);
  const beginLoad = usePersonalizationDraftStore((state) => state.beginLoad);
  const markLoadSuccess = usePersonalizationDraftStore((state) => state.markLoadSuccess);
  const markLoadError = usePersonalizationDraftStore((state) => state.markLoadError);
  const setDraft = usePersonalizationDraftStore((state) => state.setDraft);
  const beginSave = usePersonalizationDraftStore((state) => state.beginSave);
  const endSaveSuccess = usePersonalizationDraftStore((state) => state.endSaveSuccess);
  const endSaveFailure = usePersonalizationDraftStore((state) => state.endSaveFailure);

  const load = useCallback(async () => {
    const { generation, requestId } = beginLoad(settingService);
    try {
      const result = await settingService.getUserInstructions();
      markLoadSuccess(result, generation, requestId);
    } catch (error) {
      // 读取失败不能当空文件：基线缺失时禁用编辑并提供重试，否则用户输入无法安全保存。
      logger.warn("[PersonalizationSection] 读取个性化指令失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      markLoadError(generation, requestId);
    }
  }, [beginLoad, markLoadError, markLoadSuccess, settingService]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = useCallback(async () => {
    const generation = usePersonalizationDraftStore.getState().generation;
    beginSave(generation);
    try {
      await settingService.saveUserInstructions(draft);
      endSaveSuccess(draft, generation);
      toast(intl.formatMessage({ id: "settings.personalization.saved" }));
    } catch (error) {
      // 失败时草稿保留在模块级 store：即使保存中切走分区（组件已卸载），重进仍可重试。
      endSaveFailure(generation);
      logger.warn("[PersonalizationSection] 保存个性化指令失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.personalization.saveFailed" }));
    }
  }, [beginSave, draft, endSaveFailure, endSaveSuccess, intl, settingService]);

  const draftBytes = useMemo(() => countUtf8Bytes(draft), [draft]);
  const overLimit = draftBytes > USER_INSTRUCTIONS_MAX_BYTES;
  const dirty = readState === "ready" && draft !== baseline;
  const canSave = dirty && !overLimit && !saving;

  return (
    // 编辑器直接铺在页面背景上（同参照界面）；指令是自然语言，不用等宽字体。
    <div className="space-y-4">
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.personalization.description" })}
      </p>
      {readState === "error" ? (
        <div className="space-y-2">
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.personalization.loadFailed" })}
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}
      {/* 基础 Textarea 的 border-input 在浅色主题是白色（白底上不可见），改用
          SettingsFormTextarea 的 border-input-border：各主题下都是清晰的灰色框线。
          读取成功前禁用：没有基线就无法判定脏态，保存门控也不应放行。 */}
      <SettingsFormTextarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // Ctrl/Cmd+S 与保存按钮等价（同时阻止浏览器“保存网页”对话框）；门控与按钮一致。
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            if (canSave) {
              void handleSave();
            }
          }
        }}
        spellCheck={false}
        disabled={readState !== "ready" || saving}
        className="min-h-64 w-full text-ui-base"
        placeholder={intl.formatMessage({ id: "settings.personalization.placeholder" })}
        aria-label={intl.formatMessage({ id: "settings.personalization.editorLabel" })}
        data-testid={TID_SETTINGS_PERSONALIZATION_EDITOR}
      />
      <div className="flex items-start justify-between gap-3">
        {overLimit ? (
          <p
            className="text-ui-base text-destructive"
            data-testid={TID_SETTINGS_PERSONALIZATION_SIZE_HINT}
          >
            {intl.formatMessage({ id: "settings.personalization.sizeOverLimit" })}
          </p>
        ) : (
          <span />
        )}
        <span
          className={`text-ui-sm ${overLimit ? "text-destructive" : "text-foreground-subtlest"}`}
        >
          {intl.formatMessage(
            { id: "settings.personalization.sizeCount" },
            {
              used: formatKb(draftBytes),
              limit: formatKb(USER_INSTRUCTIONS_MAX_BYTES),
            },
          )}
        </span>
      </div>
      <SettingsFormActions>
        <Button
          size="lg"
          disabled={!canSave}
          onClick={() => void handleSave()}
          data-testid={TID_SETTINGS_PERSONALIZATION_SAVE}
        >
          {intl.formatMessage({ id: "common.save" })}
        </Button>
        <Button
          variant="ghost"
          size="lg"
          disabled={!dirty || saving}
          onClick={() => setDraft(baseline)}
          data-testid={TID_SETTINGS_PERSONALIZATION_CANCEL}
        >
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
        {dirty && !overLimit ? (
          <span className="self-center text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.personalization.unsaved" })}
          </span>
        ) : null}
      </SettingsFormActions>
    </div>
  );
}
