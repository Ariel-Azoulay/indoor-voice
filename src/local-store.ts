export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

interface VersionedCollection<T> {
  version: number;
  items: T[];
}

export function browserStorage(): KeyValueStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadCollection<T>(
  key: string,
  isItem: (value: unknown) => value is T,
  storage: KeyValueStorage | undefined = browserStorage(),
): T[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Accept a bare array so pre-release/local builds can migrate without data loss.
    const values = Array.isArray(parsed)
      ? parsed
      : isVersionedCollection(parsed)
        ? parsed.items
        : [];
    return values.filter(isItem);
  } catch {
    return [];
  }
}

export function saveCollection<T>(
  key: string,
  items: readonly T[],
  storage: KeyValueStorage | undefined = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    const payload: VersionedCollection<T> = { version: 1, items: [...items] };
    storage.setItem(key, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function createLocalId(prefix: string): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}-${uuid}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isVersionedCollection(value: unknown): value is VersionedCollection<unknown> {
  return Boolean(
    value
      && typeof value === "object"
      && "items" in value
      && Array.isArray((value as { items?: unknown }).items),
  );
}
