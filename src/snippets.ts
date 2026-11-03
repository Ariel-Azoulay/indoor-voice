import { createLocalId, loadCollection, saveCollection, type KeyValueStorage } from "./local-store";
import { applyTextReplacements } from "./text-replacements";

export const SNIPPETS_STORAGE_KEY = "indoor-voice:snippets:v1";

export interface Snippet {
  id: string;
  name: string;
  spokenTrigger: string;
  content: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SnippetInput {
  name: string;
  spokenTrigger: string;
  content: string;
  enabled?: boolean;
}

export function createSnippet(input: SnippetInput, now = new Date()): Snippet {
  const name = input.name.trim();
  const spokenTrigger = input.spokenTrigger.trim();
  if (!name) throw new Error("A snippet name is required.");
  if (!spokenTrigger) throw new Error("A spoken trigger is required.");
  if (!input.content) throw new Error("Snippet content cannot be empty.");
  const timestamp = now.toISOString();
  return {
    id: createLocalId("snippet"),
    name,
    spokenTrigger,
    content: input.content,
    enabled: input.enabled ?? true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function loadSnippets(storage?: KeyValueStorage): Snippet[] {
  return loadCollection(SNIPPETS_STORAGE_KEY, isSnippet, storage);
}

export function saveSnippets(snippets: readonly Snippet[], storage?: KeyValueStorage): boolean {
  return saveCollection(SNIPPETS_STORAGE_KEY, snippets, storage);
}

export function upsertSnippet(snippets: readonly Snippet[], snippet: Snippet): Snippet[] {
  const index = snippets.findIndex((candidate) => candidate.id === snippet.id);
  if (index < 0) return [...snippets, snippet];
  const next = [...snippets];
  next[index] = { ...snippet, updatedAt: new Date().toISOString() };
  return next;
}

export function removeSnippet(snippets: readonly Snippet[], id: string): Snippet[] {
  return snippets.filter((snippet) => snippet.id !== id);
}

export function applySnippets(text: string, snippets: readonly Snippet[]): string {
  return applyTextReplacements(text, snippets.map((snippet) => ({
    trigger: snippet.spokenTrigger,
    replacement: snippet.content,
    enabled: snippet.enabled,
    wholeWord: true,
  })));
}

function isSnippet(value: unknown): value is Snippet {
  if (!value || typeof value !== "object") return false;
  const snippet = value as Partial<Snippet>;
  return typeof snippet.id === "string"
    && typeof snippet.name === "string"
    && typeof snippet.spokenTrigger === "string"
    && typeof snippet.content === "string"
    && typeof snippet.enabled === "boolean"
    && typeof snippet.createdAt === "string"
    && typeof snippet.updatedAt === "string";
}
