// ============================================================
// Zod -> provider-neutral JSON Schema for tool contracts
// ============================================================

import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodTypeAny } from "zod";
import type { JsonSchema } from "../model/index.js";

const STRIPPED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
]);
export const TOOL_JSON_SCHEMA_VERSION = "https://json-schema.org/draft/2020-12/schema";

// 工具 schema 的 key 按下列顺序输出（zod v4 toJSONSchema 的顺序，与 zod-to-json-schema 不同）；
// key 顺序进入 tools 段字节，影响缓存前缀。未列出的 key 保持原相对顺序排在最后。
const SCHEMA_KEY_ORDER = [
  "$schema",
  "description",
  "default",
  "minItems",
  "maxItems",
  "type",
  "minLength",
  "maxLength",
  "format",
  "pattern",
  "allOf",
  "enum",
  "const",
  "exclusiveMinimum",
  "minimum",
  "exclusiveMaximum",
  "maximum",
  "multipleOf",
  "properties",
  "required",
  "propertyNames",
  "additionalProperties",
  "items",
  "anyOf",
  "oneOf",
];
const SCHEMA_KEY_RANK = new Map(SCHEMA_KEY_ORDER.map((key, index) => [key, index]));

/**
 * Convert a Zod runtime schema into the JSON Schema subset exposed to model
 * providers. Keep all built-in tool schemas on this path so runtime validation
 * and provider-facing function parameters cannot drift.
 */
export function toToolJsonSchema(schema: ZodTypeAny): JsonSchema {
  const jsonSchema = zodToJsonSchema(schema, {
    $refStrategy: "none",
    effectStrategy: "input",
    target: "jsonSchema7",
  }) as JsonSchema;

  normalizeToolJsonSchema(jsonSchema);
  jsonSchema.$schema = TOOL_JSON_SCHEMA_VERSION;
  orderSchemaKeys(jsonSchema);
  return jsonSchema;
}

function orderSchemaKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      orderSchemaKeys(item);
    }
    return;
  }
  if (!isRecord(value)) return;

  // properties 是属性名映射，保留声明顺序，只整理每个属性自己的 schema。
  if (isRecord(value.properties)) {
    for (const child of Object.values(value.properties)) {
      orderSchemaKeys(child);
    }
  }
  orderSchemaKeys(value.items);
  orderSchemaKeys(value.additionalProperties);
  orderSchemaKeys(value.propertyNames);
  orderSchemaKeys(value.allOf);
  orderSchemaKeys(value.anyOf);
  orderSchemaKeys(value.oneOf);

  const entries = Object.entries(value);
  const ordered = entries
    .map((entry, index) => ({
      entry,
      rank: SCHEMA_KEY_RANK.get(entry[0]) ?? SCHEMA_KEY_ORDER.length + index,
    }))
    .sort((left, right) => left.rank - right.rank);
  for (const [key] of entries) {
    delete value[key];
  }
  for (const { entry } of ordered) {
    value[entry[0]] = entry[1];
  }
}

export function normalizeToolJsonSchema(schema: JsonSchema): JsonSchema {
  normalizeSchemaNode(schema);
  return schema;
}

function normalizeSchemaNode(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      normalizeSchemaNode(item);
    }
    return;
  }

  if (!isRecord(value)) return;

  for (const key of STRIPPED_SCHEMA_KEYS) {
    delete value[key];
  }

  if (isRecord(value.properties)) {
    for (const child of Object.values(value.properties)) {
      normalizeSchemaNode(child);
    }
  }

  normalizeSchemaNode(value.items);
  normalizeSchemaNode(value.additionalProperties);
  normalizeSchemaNode(value.oneOf);
  normalizeSchemaNode(value.anyOf);
  normalizeSchemaNode(value.allOf);

  if (Array.isArray(value.anyOf) && value.oneOf === undefined) {
    value.oneOf = value.anyOf;
    delete value.anyOf;
  }

  if (value.type === undefined) {
    const inferredType = inferSchemaType(value);
    if (inferredType) {
      value.type = inferredType;
    }
  }

  const typeValues = Array.isArray(value.type) ? value.type : [value.type];
  if (
    typeValues.includes("object") &&
    !isRecord(value.properties) &&
    isRecord(value.additionalProperties) &&
    value.propertyNames === undefined
  ) {
    value.propertyNames = { type: "string" };
  }
  if (
    typeValues.includes("object") &&
    !isRecord(value.properties) &&
    value.additionalProperties === undefined
  ) {
    value.properties = {};
  }
  if (typeValues.includes("array") && value.items === undefined) {
    value.items = {};
  }
}

function inferSchemaType(schema: Record<string, unknown>): string | undefined {
  if (isRecord(schema.properties) || Array.isArray(schema.required)) {
    return "object";
  }
  if (schema.items !== undefined || typeof schema.minItems === "number" || typeof schema.maxItems === "number") {
    return "array";
  }
  if (Array.isArray(schema.enum)) {
    return inferTypeFromValues(schema.enum);
  }
  if ("const" in schema) {
    return inferTypeFromValues([schema.const]);
  }
  if (typeof schema.minLength === "number" || typeof schema.maxLength === "number") {
    return "string";
  }
  if (typeof schema.minimum === "number" || typeof schema.maximum === "number") {
    return "number";
  }
  return undefined;
}

function inferTypeFromValues(values: unknown[]): string | undefined {
  if (values.length === 0) return undefined;
  if (values.every((value) => typeof value === "string")) return "string";
  if (values.every((value) => typeof value === "boolean")) return "boolean";
  if (values.every((value) => Number.isInteger(value))) return "integer";
  if (values.every((value) => typeof value === "number")) return "number";
  if (values.every((value) => value === null)) return "null";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
