export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function objectValue(parent: JsonObject, key: string): JsonObject | null {
  const value = parent[key];
  return isJsonObject(value) ? value : null;
}

export function arrayValue(parent: JsonObject, key: string): readonly unknown[] {
  const value = parent[key];
  return Array.isArray(value) ? value : [];
}

/**
 * The key structure of an unknown payload, with types but no values, so an unrecognised webhook shape can be
 * mapped from a log line without recording anybody's name, address, or message text.
 */
export function describeShape(value: unknown, depth = 2, budget = 8): string {
  //An array is a container rather than a level of nesting, so it does not spend `depth` - a payload that wraps the
  //interesting object in a list should still show that object's keys. `budget` always decrements, which bounds the
  //recursion for untrusted input however it is nested.
  if (budget <= 0) return "...";
  if (Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${describeShape(value[0], depth, budget - 1)}]`;
  }
  if (isJsonObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    if (depth <= 0) return `{${keys.length} key(s)}`;
    return `{ ${keys.map((key) => `${key}: ${describeShape(value[key], depth - 1, budget - 1)}`).join(", ")} }`;
  }
  if (value === null) return "null";
  return typeof value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Expected JSON response but received: ${text.slice(0, 200)}`);
  }
}
