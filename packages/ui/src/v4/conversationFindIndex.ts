import type { AssistantTextRow, UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import type { ChatSearchResultHighlightRequest } from "@/v4/legacyChatViewTypes.js";
import type { ConversationTurnRenderUnit } from "@/v4/conversationTurnRenderUnits.js";
import { projectAssistantCodeComments } from "@/lib/assistantCodeComment.js";

export type ConversationFindRowKind = "userInput" | "assistantText";

export interface ConversationFindMatch {
  globalIndex: number;
  unitIndex: number;
  rowId: number;
  rowKind: ConversationFindRowKind;
  rowMatchIndex: number;
  start: number;
  end: number;
  sourceText: string;
}

export interface ConversationFindIndex {
  query: string;
  matches: ConversationFindMatch[];
  matchCount: number;
  loadedRowCount: number;
}

export interface ConversationFindMatchKey {
  rowId: number;
  rowKind: ConversationFindRowKind;
  rowMatchIndex: number;
}

interface ConversationFindTarget {
  unitIndex: number;
  rowId: number;
  rowKind: ConversationFindRowKind;
  text: string;
  normalizedText: string;
}

type FindOptions = { projectAssistantCodeComments?: boolean };
type FindTextCache = WeakMap<
  UserInputRow | AssistantTextRow,
  {
    projected: boolean;
    text: string;
    normalizedText: string;
  }
>;

export function normalizeConversationFindQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function addTargetsForUnit(
  targets: ConversationFindTarget[],
  unit: ConversationTurnRenderUnit,
  unitIndex: number,
  projectCodeComments: boolean,
  cache?: FindTextCache,
) {
  const latestAssistantState = unit.latestAssistantTextRow?.state;
  const projectUnitCodeComments =
    projectCodeComments &&
    (unit.isRunning ||
      latestAssistantState === "complete" ||
      latestAssistantState === "interrupted");
  for (const row of unit.visibleUserInputs) {
    targets.push(createTarget(unitIndex, row, false, cache));
  }
  for (const row of unit.assistantTextRows) {
    targets.push(createTarget(unitIndex, row, projectUnitCodeComments, cache));
  }
}

function createTarget(
  unitIndex: number,
  row: UserInputRow | AssistantTextRow,
  projected: boolean,
  cache?: FindTextCache,
): ConversationFindTarget {
  let prepared = cache?.get(row);
  if (!prepared || prepared.projected !== projected) {
    const text =
      projected && row.kind === "assistantText"
        ? projectAssistantCodeComments(row.text, { streaming: row.state === "streaming" })
            .visibleText
        : row.text;
    prepared = { projected, text, normalizedText: text.toLocaleLowerCase() };
    cache?.set(row, prepared);
  }
  return {
    unitIndex,
    rowId: row.rowId,
    rowKind: row.kind,
    text: prepared.text,
    normalizedText: prepared.normalizedText,
  };
}

export function buildConversationFindIndex(
  units: readonly ConversationTurnRenderUnit[],
  query: string,
  options: FindOptions = {},
): ConversationFindIndex {
  return buildFindIndex(units, query, options);
}

/** query 逐字变化时不能反复投影和转小写全部历史；弱引用跟随不可变 row 的生命期。 */
export function createConversationFindIndexBuilder() {
  const cache: FindTextCache = new WeakMap();
  return (units: readonly ConversationTurnRenderUnit[], query: string, options: FindOptions = {}) =>
    buildFindIndex(units, query, options, cache);
}

function buildFindIndex(
  units: readonly ConversationTurnRenderUnit[],
  query: string,
  options: FindOptions,
  cache?: FindTextCache,
): ConversationFindIndex {
  const normalizedQuery = normalizeConversationFindQuery(query);
  if (!normalizedQuery) {
    return {
      query: normalizedQuery,
      matches: [],
      matchCount: 0,
      loadedRowCount: units.reduce(
        (count, unit) => count + unit.visibleUserInputs.length + unit.assistantTextRows.length,
        0,
      ),
    };
  }
  const targets: ConversationFindTarget[] = [];
  units.forEach((unit, unitIndex) =>
    addTargetsForUnit(
      targets,
      unit,
      unitIndex,
      options.projectAssistantCodeComments === true,
      cache,
    ),
  );

  const matches: ConversationFindMatch[] = [];
  for (const target of targets) {
    const normalizedText = target.normalizedText;
    let searchStart = 0;
    let rowMatchIndex = 0;
    while (searchStart < normalizedText.length) {
      const matchIndex = normalizedText.indexOf(normalizedQuery, searchStart);
      if (matchIndex === -1) {
        break;
      }
      matches.push({
        globalIndex: matches.length,
        unitIndex: target.unitIndex,
        rowId: target.rowId,
        rowKind: target.rowKind,
        rowMatchIndex,
        start: matchIndex,
        end: matchIndex + normalizedQuery.length,
        sourceText: target.text,
      });
      rowMatchIndex += 1;
      searchStart = matchIndex + normalizedQuery.length;
    }
  }

  return {
    query: normalizedQuery,
    matches,
    matchCount: matches.length,
    loadedRowCount: targets.length,
  };
}

export function getConversationFindMatchKey(
  match: ConversationFindMatch | null | undefined,
): ConversationFindMatchKey | null {
  if (!match) {
    return null;
  }
  return {
    rowId: match.rowId,
    rowKind: match.rowKind,
    rowMatchIndex: match.rowMatchIndex,
  };
}

export function findConversationMatchIndexByKey(
  index: ConversationFindIndex,
  key: ConversationFindMatchKey | null | undefined,
): number {
  if (!key) {
    return -1;
  }
  return index.matches.findIndex(
    (match) =>
      match.rowId === key.rowId &&
      match.rowKind === key.rowKind &&
      match.rowMatchIndex === key.rowMatchIndex,
  );
}

export function resolveConversationFindActiveIndex(
  index: ConversationFindIndex,
  preferredIndex: number,
): number {
  if (index.matchCount === 0) {
    return -1;
  }
  if (preferredIndex >= 0 && preferredIndex < index.matchCount) {
    return preferredIndex;
  }
  return 0;
}

export function resolveConversationFindActiveMatch(
  index: ConversationFindIndex,
  preferredIndex: number,
): ConversationFindMatch | null {
  const activeIndex = resolveConversationFindActiveIndex(index, preferredIndex);
  return activeIndex >= 0 ? (index.matches[activeIndex] ?? null) : null;
}

function normalizeSearchResultProbeText(text: string): string {
  return text
    .replace(/^\.{3}/, "")
    .replace(/\.{3}$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function includesProbe(sourceText: string, probe: string): boolean {
  const normalizedSource = normalizeSearchResultProbeText(sourceText).toLocaleLowerCase();
  const normalizedProbe = normalizeSearchResultProbeText(probe).toLocaleLowerCase();
  return normalizedProbe.length > 0 && normalizedSource.includes(normalizedProbe);
}

export function resolveSearchResultHighlightMatch(
  index: ConversationFindIndex,
  request: ChatSearchResultHighlightRequest,
): ConversationFindMatch | null {
  if (index.matchCount === 0) {
    return null;
  }

  const snippet = request.snippet?.trim();
  if (snippet) {
    const snippetMatch = index.matches.find((match) => includesProbe(match.sourceText, snippet));
    if (snippetMatch) {
      return snippetMatch;
    }
  }

  const preferredIndex = request.snippetIndex ?? 0;
  return index.matches[preferredIndex] ?? index.matches[0] ?? null;
}
