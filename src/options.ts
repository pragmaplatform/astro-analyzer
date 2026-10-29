/** Helpers for a rule's `parseOptions`: each throws an `Error` naming the bad option. */

export function assertKnownOptions(raw: Record<string, unknown>, known: readonly string[]) {
  const unknown = Object.keys(raw).filter((key) => !known.includes(key))
  if (unknown.length > 0) {
    throw new Error(`unknown option ${unknown.map((k) => `"${k}"`).join(", ")}; known: ${known.join(", ") || "none"}`)
  }
}

export function stringArrayOption(raw: Record<string, unknown>, key: string, fallback: string[] = []): string[] {
  const value = raw[key] ?? fallback
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim() !== "")) {
    throw new Error(`option "${key}" must be an array of non-empty strings`)
  }
  return value
}

export function booleanOption(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key] ?? fallback
  if (typeof value !== "boolean") throw new Error(`option "${key}" must be a boolean`)
  return value
}
