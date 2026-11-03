import type { MobilePushEvent } from "#src/web-remote-relay/contract.js";
export interface MobilePushObservation {
  sessionId: string;
  title?: string;
  phase: string;
  lastActivityAt: number;
  pendingInteraction?: {
    interactionId: string;
    kind: "permission" | "userInput";
    toolName?: string;
    autoResolution?: { state: string };
  };
}
/** 只接受相邻实时投影；调用方在 snapshot/recovery 时只更新基线。 */
export function collectMobilePushEvents(
  workspaceId: string,
  previous: MobilePushObservation | undefined,
  next: MobilePushObservation,
): MobilePushEvent[] {
  if (!previous) return [];
  const events: MobilePushEvent[] = [];
  const interaction = (value: MobilePushObservation, state: "open" | "resolved") => {
    const pending = value.pendingInteraction;
    if (!pending || pending.autoResolution) return;
    const kind =
      pending.kind === "permission"
        ? "approval"
        : pending.toolName === "ExitPlanMode"
          ? "plan"
          : "question";
    events.push({
      version: 1,
      event_id: `${pending.interactionId}:${state}`,
      kind,
      workspace_id: workspaceId,
      session_id: next.sessionId,
      run_id: pending.interactionId,
      interaction_id: pending.interactionId,
      state,
      occurred_at: Math.floor(next.lastActivityAt / 1000),
    });
  };
  if (previous.pendingInteraction?.interactionId !== next.pendingInteraction?.interactionId) {
    interaction(previous, "resolved");
    interaction(next, "open");
  }
  if (
    previous.phase !== next.phase &&
    (previous.phase === "running" || previous.phase === "prewarming")
  ) {
    const kind =
      next.phase === "completedSuccess"
        ? "task_completed"
        : next.phase === "error"
          ? "task_failed"
          : null;
    if (kind)
      events.push({
        version: 1,
        event_id: `${next.sessionId}:${next.lastActivityAt}:${kind}`,
        kind,
        workspace_id: workspaceId,
        session_id: next.sessionId,
        run_id: String(next.lastActivityAt),
        state: "open",
        occurred_at: Math.floor(next.lastActivityAt / 1000),
      });
  }
  return events.map((event) => ({
    ...event,
    session_title: next.title ? Array.from(next.title).slice(0, 256).join("") : undefined,
  }));
}
