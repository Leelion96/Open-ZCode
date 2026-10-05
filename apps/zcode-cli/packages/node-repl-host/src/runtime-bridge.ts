import type { BrowserClientTransport } from "@zcode/core/browser-client";
import { PRODUCT_DISPLAY_NAME } from "@zcode/shared/product";

export const NODE_REPL_BROWSER_BRIDGE_SYMBOL = Symbol.for("zcode.node-repl.browser-control-bridge");
export const BROWSER_UNAVAILABLE_IN_SUBAGENT_MESSAGE = "Browser is not available in subagent";

export interface NodeReplBrowserRuntimeBridge extends BrowserClientTransport {
  documentationRoot: string;
  assertAvailable(): void;
}

export function readNodeReplBrowserRuntimeBridge(
  globals: Record<PropertyKey, unknown>,
): NodeReplBrowserRuntimeBridge {
  const bridge = globals[NODE_REPL_BROWSER_BRIDGE_SYMBOL];
  if (!bridge || typeof bridge !== "object") {
    throw new Error(
      `Browser runtime bridge is unavailable. Use Browser through the ${PRODUCT_DISPLAY_NAME} desktop app or its shared-host runtime.`,
    );
  }
  return bridge as NodeReplBrowserRuntimeBridge;
}
