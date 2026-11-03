// ============================================================
// Current Date Section Builder
// ============================================================

import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

export function buildCurrentDateSection(currentDate: string | undefined): ContextSection | null {
  if (!currentDate) {
    return null;
  }

  const content = `Today's date is ${currentDate}.`;

  return {
    name: "Current Date",
    source: "current_date",
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
