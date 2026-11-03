import { createLocalId, loadCollection, saveCollection, type KeyValueStorage } from "./local-store";
import { applyTextReplacements } from "./text-replacements";

export const DICTIONARY_STORAGE_KEY = "indoor-voice:dictionary:v1";

export interface DictionaryEntry {
  id: string;
  spoken: string;
  written: string;
  enabled: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DictionaryEntryInput {
  spoken: string;
  written: string;
  enabled?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

export function createDictionaryEntry(input: DictionaryEntryInput, now = new Date()): DictionaryEntry {
  const spoken = input.spoken.trim();
  const written = input.written.trim();
  if (!spoken) throw new Error("A spoken form is required.");
  if (!written) throw new Error("A written form is required.");
  const timestamp = now.toISOString();
  return {
    id: createLocalId("dict"),
    spoken,
    written,
    enabled: input.enabled ?? true,
    caseSensitive: input.caseSensitive ?? false,
    wholeWord: input.wholeWord ?? true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function loadDictionary(storage?: KeyValueStorage): DictionaryEntry[] {
  return loadCollection(DICTIONARY_STORAGE_KEY, isDictionaryEntry, storage);
}

export function saveDictionary(entries: readonly DictionaryEntry[], storage?: KeyValueStorage): boolean {
  return saveCollection(DICTIONARY_STORAGE_KEY, entries, storage);
}

export function upsertDictionaryEntry(
  entries: readonly DictionaryEntry[],
  entry: DictionaryEntry,
): DictionaryEntry[] {
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  if (index < 0) return [...entries, entry];
  const next = [...entries];
  next[index] = { ...entry, updatedAt: new Date().toISOString() };
  return next;
}

export function removeDictionaryEntry(entries: readonly DictionaryEntry[], id: string): DictionaryEntry[] {
  return entries.filter((entry) => entry.id !== id);
}

export function applyDictionary(text: string, entries: readonly DictionaryEntry[]): string {
  return applyTextReplacements(text, entries.map((entry) => ({
    trigger: entry.spoken,
    replacement: entry.written,
    enabled: entry.enabled,
    caseSensitive: entry.caseSensitive,
    wholeWord: entry.wholeWord,
  })));
}

function isDictionaryEntry(value: unknown): value is DictionaryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<DictionaryEntry>;
  return typeof entry.id === "string"
    && typeof entry.spoken === "string"
    && typeof entry.written === "string"
    && typeof entry.enabled === "boolean"
    && typeof entry.caseSensitive === "boolean"
    && typeof entry.wholeWord === "boolean"
    && typeof entry.createdAt === "string"
    && typeof entry.updatedAt === "string";
}
