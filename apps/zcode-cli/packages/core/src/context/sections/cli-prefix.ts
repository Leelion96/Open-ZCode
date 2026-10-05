import { PRODUCT_DISPLAY_NAME } from "@zcode/shared/product";
// ============================================================
// CLI Prefix Section Builder
// ============================================================

import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

const CLI_PREFIX_PROMPT = `You are ${PRODUCT_DISPLAY_NAME}, an interactive coding agent`;

export function buildCliPrefixSection(): ContextSection {
  const content = CLI_PREFIX_PROMPT;

  return {
    name: "CLI Prefix",
    source: "cli_prefix",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
