// ============================================================
// Tracing - Trace context propagation
// ============================================================

import type { QueryId, SessionId, TraceId, TurnId } from "../interfaces/shared.js";
import { createTraceId } from "../interfaces/shared.js";
import { AsyncLocalStorage } from "async_hooks";
import type { Logger, LogContext } from "../logging/logger.js";

// -----------------------------------------------
// Trace Context
// -----------------------------------------------

export interface TraceContext {
  traceId: TraceId;
  queryId?: QueryId;
  spanId?: string;
  parentSpanId?: string;
  parentId?: string;
  sessionId?: SessionId;
  /**
   * Top-level session that spawned this one (subagent, workflow actor); absent on a top-level
   * session. Set where a child session is spawned and inherited by every child context below it.
   */
  rootSessionId?: SessionId;
  turnId?: TurnId;
  attributes?: Record<string, string | number | boolean>;
}

export interface ExecutionContext {
  trace: TraceContext;
  logger: Logger;
  abortSignal?: AbortSignal;
}

// -----------------------------------------------
// Span (single unit of work within a trace)
// -----------------------------------------------

export interface Span {
  readonly traceId: TraceId;
  readonly spanId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly startTime: Date;
  endTime?: Date;
  attributes: Record<string, string | number | boolean>;
  status: "running" | "completed" | "error";
  error?: Error;

  setAttribute(key: string, value: string | number | boolean): void;
  setAttributes(attributes: Record<string, string | number | boolean>): void;
  end(error?: Error): void;
  addEvent(name: string, attributes?: Record<string, string | number | boolean>): void;
}

class SpanImpl implements Span {
  readonly traceId: TraceId;
  readonly spanId: string;
  readonly parentId?: string;
  readonly name: string;
  readonly startTime: Date;
  endTime?: Date;
  attributes: Record<string, string | number | boolean>;
  status: "running" | "completed" | "error" = "running";
  error?: Error;

  private onEnd?: (span: Span) => void;

  constructor(name: string, traceId: TraceId, parentId?: string, onEnd?: (span: Span) => void) {
    this.name = name;
    this.traceId = traceId;
    this.spanId = generateSpanId();
    this.parentId = parentId;
    this.startTime = new Date();
    this.attributes = {};
    this.onEnd = onEnd;
  }

  setAttribute(key: string, value: string | number | boolean): void {
    this.attributes[key] = value;
  }

  setAttributes(attributes: Record<string, string | number | boolean>): void {
    Object.assign(this.attributes, attributes);
  }

  end(error?: Error): void {
    if (this.status !== "running") return;
    this.endTime = new Date();
    if (error) {
      this.status = "error";
      this.error = error;
    } else {
      this.status = "completed";
    }
    this.onEnd?.(this);
  }

  addEvent(_name: string, _attributes?: Record<string, string | number | boolean>): void {
    // Could emit events for external tracing systems
  }
}

function generateSpanId(): string {
  return crypto.randomUUID().slice(0, 16);
}

// -----------------------------------------------
// Tracer
// -----------------------------------------------

export interface Tracer {
  readonly name: string;
  startSpan(name: string, parentContext?: TraceContext): Span;
  withSpan<T>(name: string, fn: (span: Span) => T, parentContext?: TraceContext): T;
  withSpanAsync<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    parentContext?: TraceContext,
  ): Promise<T>;
}

export function createTracer(name: string, onSpanEnd?: (span: Span) => void): Tracer {
  return {
    name,
    startSpan(name: string, parentContext?: TraceContext): Span {
      const traceId = parentContext?.traceId ?? (createTraceId() as TraceId);
      return new SpanImpl(
        name,
        traceId,
        parentContext?.spanId ?? parentContext?.parentSpanId,
        onSpanEnd,
      );
    },
    withSpan<T>(name: string, fn: (span: Span) => T, parentContext?: TraceContext): T {
      const span = this.startSpan(name, parentContext);
      try {
        const result = fn(span);
        span.end();
        return result;
      } catch (error) {
        span.end(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    },
    withSpanAsync<T>(
      name: string,
      fn: (span: Span) => Promise<T>,
      parentContext?: TraceContext,
    ): Promise<T> {
      const span = this.startSpan(name, parentContext);
      return fn(span).then(
        (result) => {
          span.end();
          return result;
        },
        (error) => {
          span.end(error instanceof Error ? error : new Error(String(error)));
          throw error;
        },
      );
    },
  };
}

// -----------------------------------------------
// Async Local Storage for Context Propagation
// -----------------------------------------------

const _storage = new AsyncLocalStorage<TraceContext>();

export function getCurrentTraceContext(): TraceContext | undefined {
  return _storage.getStore();
}

export function runWithContext<T>(context: TraceContext, fn: () => T): T {
  return _storage.run(context, fn);
}

export async function runWithContextAsync<T>(
  context: TraceContext,
  fn: () => Promise<T>,
): Promise<T> {
  return _storage.run(context, fn);
}

// -----------------------------------------------
// Convenience: create span from current context
// -----------------------------------------------

export function createSpan(name: string): Span {
  const currentContext = getCurrentTraceContext();
  const traceId = currentContext?.traceId ?? (createTraceId() as TraceId);
  return new SpanImpl(name, traceId, currentContext?.spanId ?? currentContext?.parentSpanId);
}

export function createRootTraceContext(
  options: {
    traceId?: TraceId;
    queryId?: QueryId;
    sessionId?: SessionId;
    turnId?: TurnId;
    attributes?: Record<string, string | number | boolean>;
  } = {},
): TraceContext {
  return {
    traceId: options.traceId ?? createTraceId(),
    queryId: options.queryId,
    spanId: generateSpanId(),
    sessionId: options.sessionId,
    turnId: options.turnId,
    attributes: options.attributes,
  };
}

export function createChildTraceContext(
  parent: TraceContext,
  options: {
    queryId?: QueryId;
    sessionId?: SessionId;
    rootSessionId?: SessionId;
    turnId?: TurnId;
    attributes?: Record<string, string | number | boolean>;
  } = {},
): TraceContext {
  return {
    traceId: parent.traceId,
    queryId: options.queryId ?? parent.queryId,
    spanId: generateSpanId(),
    parentSpanId: parent.spanId,
    parentId: parent.spanId,
    sessionId: options.sessionId ?? parent.sessionId,
    ...((options.rootSessionId ?? parent.rootSessionId)
      ? { rootSessionId: options.rootSessionId ?? parent.rootSessionId }
      : {}),
    turnId: options.turnId ?? parent.turnId,
    attributes: {
      ...parent.attributes,
      ...options.attributes,
    },
  };
}

export function traceContextToLogContext(context: TraceContext): LogContext {
  return {
    traceId: context.traceId,
    queryId: context.queryId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
    ...context.attributes,
  };
}
