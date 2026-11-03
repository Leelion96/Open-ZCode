import {
  ConversationTelemetryEngine,
  type TelemetryPlatform,
  type ConversationTelemetryObservation,
} from "@zcode/shared/conversation-telemetry";
export * from "@zcode/shared/conversation-telemetry";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import {
  reportChatErrorBannerTelemetry,
  resolveVisibleChatErrorTelemetryRecoveryAction,
  type ChatErrorBannerSurface,
} from "@/lib/chatErrorBannerTelemetry.js";
import {
  reportPlanUsageModelRequestStartedToArms,
  reportPlanUsageTtftToArms,
} from "@/lib/planUsageArmsTelemetry.js";
import {
  reportSendFunnelInputFocus,
  reportSendFunnelSendClick,
  reportSendFunnelSendResult,
} from "@/lib/sendFunnelArmsTelemetry.js";
import {
  clearStreamStallTracking,
  recordStreamChunkArrival,
  reportUiFirstToken,
  reportUiMessageComplete,
  reportUiToolCallDetail,
  reportUiTurnBreakdown,
} from "@/lib/uiPerfArmsTelemetry.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";

const observers = {
  reportSendFunnelInputFocus: (args: readonly unknown[]) =>
    reportSendFunnelInputFocus(...(args as Parameters<typeof reportSendFunnelInputFocus>)),
  reportSendFunnelSendClick: (args: readonly unknown[]) =>
    reportSendFunnelSendClick(...(args as Parameters<typeof reportSendFunnelSendClick>)),
  reportSendFunnelSendResult: (args: readonly unknown[]) =>
    reportSendFunnelSendResult(...(args as Parameters<typeof reportSendFunnelSendResult>)),
  reportPlanUsageModelRequestStartedToArms: (args: readonly unknown[]) =>
    reportPlanUsageModelRequestStartedToArms(
      ...(args as Parameters<typeof reportPlanUsageModelRequestStartedToArms>),
    ),
  reportPlanUsageTtftToArms: (args: readonly unknown[]) =>
    reportPlanUsageTtftToArms(...(args as Parameters<typeof reportPlanUsageTtftToArms>)),
  clearStreamStallTracking: (args: readonly unknown[]) =>
    clearStreamStallTracking(...(args as Parameters<typeof clearStreamStallTracking>)),
  recordStreamChunkArrival: (args: readonly unknown[]) =>
    recordStreamChunkArrival(...(args as Parameters<typeof recordStreamChunkArrival>)),
  reportUiFirstToken: (args: readonly unknown[]) =>
    reportUiFirstToken(...(args as Parameters<typeof reportUiFirstToken>)),
  reportUiMessageComplete: (args: readonly unknown[]) =>
    reportUiMessageComplete(...(args as Parameters<typeof reportUiMessageComplete>)),
  reportUiToolCallDetail: (args: readonly unknown[]) =>
    reportUiToolCallDetail(...(args as Parameters<typeof reportUiToolCallDetail>)),
  reportUiTurnBreakdown: (args: readonly unknown[]) =>
    reportUiTurnBreakdown(...(args as Parameters<typeof reportUiTurnBreakdown>)),
} satisfies Record<ConversationTelemetryObservation, (args: readonly unknown[]) => unknown>;

export class ConversationTelemetrySupervisor extends ConversationTelemetryEngine {
  private readonly uiPlatform: TelemetryPlatform;
  private uiDisposed = false;

  constructor(
    options: Omit<
      ConstructorParameters<typeof ConversationTelemetryEngine>[0],
      "reportEvent" | "observer"
    >,
  ) {
    super({
      ...options,
      observer: (name, args) => {
        observers[name](args);
      },
      reportEvent: (payload) =>
        reportAppTelemetryEvent(options.platform, payload, "v4-conversation-telemetry"),
    });
    this.uiPlatform = options.platform;
  }

  reportVisibleChatError(params: {
    surface?: ChatErrorBannerSurface;
    errorKey?: string | null;
    displayMessage: string;
    error: ZCodeUiError;
  }): void {
    if (this.uiDisposed) return;
    void reportChatErrorBannerTelemetry(this.uiPlatform, {
      ...params,
      providerBusinessRecoveryAction: resolveVisibleChatErrorTelemetryRecoveryAction(params.error),
    });
  }

  override dispose(): void {
    this.uiDisposed = true;
    super.dispose();
  }
}
