export type ProviderId = "openai" | "anthropic" | "gemini" | "bedrock" | "local";

export interface PlatformCapabilities {
  platform: string;
  apple_speech_candidate: boolean;
  apple_foundation_model_candidate: boolean;
  secure_store: string;
  default_shortcut: string;
}

export interface ProviderDefinition {
  id: ProviderId;
  name: string;
  detail: string;
  local: boolean;
  implemented: boolean;
  defaultModel: string;
}

export type PillState =
  | "idle"
  | "listening"
  | "handsfree"
  | "working"
  | "success"
  | "error";

export interface ModelStatus {
  ready: boolean;
  name: string;
  size_mb: number;
  profile?: string;
  file?: string;
  quality?: string;
}

export interface DownloadProgress {
  downloaded: number;
  total: number;
  percent: number;
}

export interface RecordingEntry {
  id: string;
  title: string;
  createdAt: number;
  durationSeconds: number;
  words: number;
  transcript: string;
}

export interface TranscriptionResult {
  text: string;
  recording: RecordingEntry | null;
  capturedSeconds?: number;
  speechSeconds?: number;
}

export interface CleanupUsage {
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface CleanupResult {
  text: string;
  usage: CleanupUsage;
}
