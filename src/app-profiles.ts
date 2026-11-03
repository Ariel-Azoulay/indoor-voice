import { createLocalId, loadCollection, saveCollection, type KeyValueStorage } from "./local-store";
import { DEFAULT_LIST_STYLE, type ListStyle } from "./list-formatting";

export const APP_PROFILES_STORAGE_KEY = "indoor-voice:app-profiles:v1";

export type ProfileLanguage = "auto" | "en-he" | "en" | "he";
export type ProfileModel = "fast" | "balanced" | "best";

export interface AppProfile {
  id: string;
  name: string;
  appNames: string[];
  bundleIdentifiers: string[];
  enabled: boolean;
  language: ProfileLanguage;
  model: ProfileModel;
  listStyle: ListStyle;
  voiceCommandsEnabled: boolean;
  dictionaryEnabled: boolean;
  snippetsEnabled: boolean;
  cleanupPreset: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppProfileInput {
  name: string;
  appNames?: string[];
  bundleIdentifiers?: string[];
  enabled?: boolean;
  language?: ProfileLanguage;
  model?: ProfileModel;
  listStyle?: ListStyle;
  voiceCommandsEnabled?: boolean;
  dictionaryEnabled?: boolean;
  snippetsEnabled?: boolean;
  cleanupPreset?: string | null;
}

export interface ForegroundAppIdentity {
  name?: string | null;
  bundleIdentifier?: string | null;
}

export function createAppProfile(input: AppProfileInput, now = new Date()): AppProfile {
  const name = input.name.trim();
  if (!name) throw new Error("A profile name is required.");
  const timestamp = now.toISOString();
  return {
    id: createLocalId("profile"),
    name,
    appNames: normalizeIdentifiers(input.appNames ?? []),
    bundleIdentifiers: normalizeIdentifiers(input.bundleIdentifiers ?? []),
    enabled: input.enabled ?? true,
    language: input.language ?? "auto",
    model: input.model ?? "balanced",
    listStyle: input.listStyle ?? DEFAULT_LIST_STYLE,
    voiceCommandsEnabled: input.voiceCommandsEnabled ?? true,
    dictionaryEnabled: input.dictionaryEnabled ?? true,
    snippetsEnabled: input.snippetsEnabled ?? true,
    cleanupPreset: input.cleanupPreset?.trim() || null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function loadAppProfiles(storage?: KeyValueStorage): AppProfile[] {
  return loadCollection(APP_PROFILES_STORAGE_KEY, isAppProfile, storage);
}

export function saveAppProfiles(profiles: readonly AppProfile[], storage?: KeyValueStorage): boolean {
  return saveCollection(APP_PROFILES_STORAGE_KEY, profiles, storage);
}

export function upsertAppProfile(profiles: readonly AppProfile[], profile: AppProfile): AppProfile[] {
  const index = profiles.findIndex((candidate) => candidate.id === profile.id);
  if (index < 0) return [...profiles, profile];
  const next = [...profiles];
  next[index] = { ...profile, updatedAt: new Date().toISOString() };
  return next;
}

export function removeAppProfile(profiles: readonly AppProfile[], id: string): AppProfile[] {
  return profiles.filter((profile) => profile.id !== id);
}

/** Bundle identifiers have priority because display names can be localized. */
export function resolveAppProfile(
  profiles: readonly AppProfile[],
  app: ForegroundAppIdentity,
): AppProfile | undefined {
  const enabled = profiles.filter((profile) => profile.enabled);
  const bundleIdentifier = normalizeIdentity(app.bundleIdentifier);
  if (bundleIdentifier) {
    const bundleMatch = enabled.find((profile) => profile.bundleIdentifiers.includes(bundleIdentifier));
    if (bundleMatch) return bundleMatch;
  }
  const name = normalizeIdentity(app.name);
  return name ? enabled.find((profile) => profile.appNames.includes(name)) : undefined;
}

function normalizeIdentifiers(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeIdentity).filter((value): value is string => Boolean(value)))];
}

function normalizeIdentity(value: string | null | undefined): string | undefined {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized || undefined;
}

function isAppProfile(value: unknown): value is AppProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<AppProfile>;
  return typeof profile.id === "string"
    && typeof profile.name === "string"
    && Array.isArray(profile.appNames) && profile.appNames.every((item) => typeof item === "string")
    && Array.isArray(profile.bundleIdentifiers) && profile.bundleIdentifiers.every((item) => typeof item === "string")
    && typeof profile.enabled === "boolean"
    && (profile.language === "auto" || profile.language === "en-he" || profile.language === "en" || profile.language === "he")
    && (profile.model === "fast" || profile.model === "balanced" || profile.model === "best")
    && (profile.listStyle === "dashes" || profile.listStyle === "dots" || profile.listStyle === "numbers" || profile.listStyle === "letters")
    && typeof profile.voiceCommandsEnabled === "boolean"
    && typeof profile.dictionaryEnabled === "boolean"
    && typeof profile.snippetsEnabled === "boolean"
    && (profile.cleanupPreset === null || typeof profile.cleanupPreset === "string")
    && typeof profile.createdAt === "string"
    && typeof profile.updatedAt === "string";
}
