import * as P from "effect/Predicate";

export function deepMerge<T>(current: T, patch: unknown): T {
  if (
    !P.isObject(current) ||
    !P.isObject(patch) ||
    Array.isArray(current) ||
    Array.isArray(patch)
  ) {
    return patch as T;
  }

  const next = { ...current } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;

    const existing = next[key];
    next[key] =
      P.isObject(existing) && P.isObject(value) && !Array.isArray(existing) && !Array.isArray(value)
        ? deepMerge(existing, value)
        : value;
  }

  return next as T;
}
