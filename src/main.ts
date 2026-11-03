import "./styles.css";
import "./reference-design.css";
import "./waveform.css";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import type {
  PillState,
  PlatformCapabilities,
  ProviderDefinition,
  ProviderId,
  DownloadProgress,
  ModelStatus,
  RecordingEntry,
  TranscriptionResult,
  CleanupResult,
  CleanupUsage,
} from "./types";
import {
  applyPillCustomization,
  CLEANUP_PROMPT_KEY,
  DEFAULT_CLEANUP_PROMPT,
  DEFAULT_PILL_CUSTOMIZATION,
  loadCleanupPrompt,
  loadPillCustomization,
  normalizePillCustomization,
  savePillCustomization,
  stateCustomization,
  type CustomizablePillState,
  type PillContentMode,
  type PillPosition,
} from "./customization";
import { applyWaveformEffect, applyWaveformLevel, brandWaveformMarkup, setWaveformMode } from "./waveform";
import { transitionPillContent } from "./pill-motion";
import {
  DEFAULT_LIST_STYLE,
  formatSpokenLists,
  LIST_STYLE_KEY,
  normalizeListStyle,
  type ListStyle,
} from "./list-formatting";
import {
  applyDictionary,
  createDictionaryEntry,
  loadDictionary,
  removeDictionaryEntry,
  saveDictionary,
  type DictionaryEntry,
} from "./dictionary";
import {
  applySnippets,
  createSnippet,
  loadSnippets,
  removeSnippet,
  saveSnippets,
  type Snippet,
} from "./snippets";
import { applyVoiceFormattingCommands } from "./voice-formatting";
import { normalizeUnicodeText } from "./unicode-text";
import {
  createAppProfile,
  loadAppProfiles,
  removeAppProfile,
  resolveAppProfile,
  saveAppProfiles,
  type AppProfile,
  type ForegroundAppIdentity,
} from "./app-profiles";

const providers: ProviderDefinition[] = [
  {
    id: "local",
    name: "Local model",
    detail: "Ollama or another OpenAI-compatible service on this computer",
    local: true,
    implemented: true,
    defaultModel: "qwen3:4b",
  },
  {
    id: "openai",
    name: "OpenAI",
    detail: "Transcript text only. Audio is never uploaded.",
    local: false,
    implemented: true,
    defaultModel: "gpt-5-mini",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    detail: "Claude cleanup through the native Messages API.",
    local: false,
    implemented: true,
    defaultModel: "claude-sonnet-4-5",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    detail: "Gemini cleanup through Google's fixed HTTPS endpoint.",
    local: false,
    implemented: true,
    defaultModel: "gemini-3.5-flash-lite",
  },
  {
    id: "bedrock",
    name: "Amazon Bedrock",
    detail: "Amazon Bedrock API key with a user-selected AWS region.",
    local: false,
    implemented: true,
    defaultModel: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  },
];

let recordingHistory: RecordingEntry[] = [];
let dictionaryEntries: DictionaryEntry[] = loadDictionary();
let snippets: Snippet[] = loadSnippets();
let appProfiles: AppProfile[] = loadAppProfiles();
let activeAppProfile: AppProfile | undefined;

interface ModelUsageTotal extends CleanupUsage {
  calls: number;
}

interface UsageStatistics {
  version: 1;
  dictations: number;
  audioSeconds: number;
  words: number;
  models: Record<string, ModelUsageTotal>;
}

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  freeTier: boolean;
}

const STATS_KEY = "indoor-voice:usage-statistics:v1";
const PRICING_KEY_PREFIX = "indoor-voice:model-pricing:v1:";

function emptyStatistics(): UsageStatistics {
  return { version: 1, dictations: 0, audioSeconds: 0, words: 0, models: {} };
}

function loadStatistics(): UsageStatistics {
  try {
    const value = JSON.parse(localStorage.getItem(STATS_KEY) ?? "null") as Partial<UsageStatistics> | null;
    if (!value || value.version !== 1) return emptyStatistics();
    return {
      version: 1,
      dictations: Number.isFinite(value.dictations) ? Math.max(0, value.dictations ?? 0) : 0,
      audioSeconds: Number.isFinite(value.audioSeconds) ? Math.max(0, value.audioSeconds ?? 0) : 0,
      words: Number.isFinite(value.words) ? Math.max(0, value.words ?? 0) : 0,
      models: value.models && typeof value.models === "object" ? value.models : {},
    };
  } catch {
    return emptyStatistics();
  }
}

function pricingKey(provider: string, model: string): string {
  return `${PRICING_KEY_PREFIX}${encodeURIComponent(provider)}:${encodeURIComponent(model)}`;
}

function defaultPricing(provider: string, model: string): ModelPricing {
  if (provider === "gemini" && model === "gemini-3.5-flash-lite") {
    return { inputPerMillion: 0.3, outputPerMillion: 2.5, freeTier: false };
  }
  return { inputPerMillion: 0, outputPerMillion: 0, freeTier: false };
}

function loadPricing(provider: string, model: string): ModelPricing {
  const fallback = defaultPricing(provider, model);
  try {
    const value = JSON.parse(localStorage.getItem(pricingKey(provider, model)) ?? "null") as Partial<ModelPricing> | null;
    if (!value) return fallback;
    return {
      inputPerMillion: Number.isFinite(value.inputPerMillion) ? Math.max(0, value.inputPerMillion ?? 0) : fallback.inputPerMillion,
      outputPerMillion: Number.isFinite(value.outputPerMillion) ? Math.max(0, value.outputPerMillion ?? 0) : fallback.outputPerMillion,
      freeTier: value.freeTier === true,
    };
  } catch {
    return fallback;
  }
}

function estimatedUsageCost(usage: ModelUsageTotal): number {
  if (usage.provider === "local") return 0;
  const pricing = loadPricing(usage.provider, usage.model);
  if (pricing.freeTier) return 0;
  return (usage.inputTokens * pricing.inputPerMillion + usage.outputTokens * pricing.outputPerMillion) / 1_000_000;
}

function navIcon(path: string): string {
  return `<svg class="nav-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}" /></svg>`;
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("App root not found");
const brandWaveUrl = new URL("../color-sine-wave-logo.png", import.meta.url).href;

app.innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><svg class="logo brand-app-icon" viewBox="0 150 1774 587" aria-hidden="true" focusable="false"><image href="${brandWaveUrl}" x="0" y="0" width="1774" height="887" /></svg><span>Indoor Voice<small>Private dictation for Mac</small></span></div>
      <nav aria-label="Main navigation">
        <button class="nav-item active" data-page="home" aria-current="page">${navIcon("M5 12.5 12 6l7 6.5V20h-5v-5h-4v5H5z")}<span>Dictation</span></button>
        <button class="nav-item" data-page="appearance">${navIcon("M12 3a9 9 0 1 0 0 18V3Zm0 0a9 9 0 0 1 0 18")}<span>Appearance</span></button>
        <button class="nav-item" data-page="history">${navIcon("M4 6.5h16v13H4zM8 3.5h8M8 11h8M8 15h5")}<span>History</span></button>
        <button class="nav-item" data-page="stats">${navIcon("M5 19V9m7 10V5m7 14v-7")}<span>Statistics</span></button>
        <button class="nav-item" data-page="providers">${navIcon("M12 3v4m0 10v4M3 12h4m10 0h4M5.6 5.6l2.8 2.8m7.2 7.2 2.8 2.8m0-12.8-2.8 2.8m-7.2 7.2-2.8 2.8M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6")}<span>Text Cleanup</span></button>
        <button class="nav-item" data-page="dictionary">${navIcon("M4 5.5A3.5 3.5 0 0 1 7.5 2H12v17H7.5A3.5 3.5 0 0 0 4 22zm16 0A3.5 3.5 0 0 0 16.5 2H12v17h4.5A3.5 3.5 0 0 1 20 22z")}<span>Personalization</span></button>
        <button class="nav-item" data-page="privacy">${navIcon("M12 3 5.5 6v5.5c0 4.3 2.7 7.7 6.5 9.5 3.8-1.8 6.5-5.2 6.5-9.5V6z")}<span>Privacy</span></button>
      </nav>
      <div class="privacy-note"><strong>Local by default</strong><span>Your microphone audio never leaves this computer.</span></div>
    </aside>
    <main class="main">
      <section class="page active home-page" id="page-home">
        <header class="page-header home-header"><div><p class="eyebrow">Dictation</p><h1>Speak. Your words appear here.</h1><p>Hold your shortcut, speak, then release. Transcription runs on this computer.</p></div><span class="status-badge platform-badge" id="platform-badge"><i></i>Checking system…</span></header>
        <div class="setup-panel" id="setup-panel">
          <div class="setup-symbol" aria-hidden="true"><span>↓</span></div><div class="setup-copy"><span class="setup-step">Set up dictation</span><strong id="model-setup-title">Checking Whisper…</strong><p id="model-setup-detail">Whisper transcribes speech on this computer.</p><div class="model-progress" id="model-progress" hidden><i></i></div></div>
          <div class="setup-actions"><button class="button primary" id="download-model" disabled>Download Whisper</button><button class="button" id="enable-microphone">Allow Microphone</button><button class="button" id="enable-accessibility">Allow Text Insertion</button></div>
        </div>
        <div class="home-hero setup-dependent">
          <div class="home-hero-copy">
            <span class="local-chip"><i></i>On-device audio</span>
            <h2>Dictate in any app.</h2>
            <p>Your speech becomes text on this computer. Optional Text Cleanup can improve it before insertion.</p>
            <div class="instruction-banner home-shortcut">
              <div><span class="shortcut-kicker">Dictation shortcut</span><strong><span id="shortcut-action-label">Hold</span> <kbd id="shortcut-label">⌥ Space</kbd></strong><p id="shortcut-status">Release to transcribe. You can change this shortcut at any time.</p></div>
              <button class="shortcut-edit shortcut-change" type="button" aria-label="Change dictation shortcut">Change</button>
            </div>
            <div class="demo-controls"><button class="button primary" id="try-pill"><span class="button-mic">●</span> Hold to try</button><button class="button quiet" id="undo-insertion" disabled>Undo Insert</button><button class="button quiet" id="reset-pill">Clear</button></div>
            <p class="demo-message" id="demo-message">Download the local model, then hold this button or your shortcut to dictate.</p>
          </div>
          <div class="home-voice-stage" id="demo-scene">
            <div class="voice-ambient" aria-hidden="true"><i></i><i></i><i></i></div>
            <div class="pill-cluster home-pill-cluster idle" id="voice-pill-cluster">
              <div class="voice-pill idle" id="voice-pill" role="status" aria-live="polite" aria-label="Voice input ready"><span class="pill-content"></span></div>
              <button class="pill-cancel-detached" id="voice-pill-cancel" type="button" data-cancel-processing aria-label="Cancel transcription" aria-hidden="true" disabled>${navIcon("M7 7l10 10M17 7 7 17")}</button>
            </div>
            <div class="latest-dictation">
              <div><span>Latest dictation</span><small>Appears here after transcription</small></div>
              <p id="inserted-text" dir="auto"></p><span class="caret"></span>
            </div>
            <div class="stage-route"><span id="input-mode-badge">PTT · Hold to talk</span><span id="language-mode-badge">English / עברית · Smart</span><span>Audio · Local only</span></div>
          </div>
        </div>
        <div class="home-glance setup-dependent" aria-label="Usage at a glance">
          <article><span class="glance-icon">Aa</span><div><strong id="home-words">0</strong><small>words dictated</small></div></article>
          <article><span class="glance-icon">↗</span><div><strong id="home-time-saved">0m</strong><small>estimated time saved</small></div></article>
          <article><span class="glance-icon">◉</span><div><strong id="home-dictations">0</strong><small>dictations completed</small></div></article>
        </div>
        <div class="section-title home-section-title setup-dependent"><div><p class="eyebrow">Status</p><h2>Dictation setup</h2><p>See what is ready and where text is processed.</p></div><button class="text-button" data-page-link="privacy" type="button">Open Privacy Settings</button></div>
        <div class="engine-grid setup-dependent">
          <article class="engine-card active-engine"><div class="engine-icon">W</div><div><span class="engine-state">Active</span><strong>Local Whisper</strong><p id="whisper-engine-status">Checking model…</p></div></article>
          <article class="engine-card"><div class="engine-icon"></div><div><span class="engine-state muted">Unavailable</span><strong>Apple transcription</strong><p id="apple-engine-status">Indoor Voice is using Whisper</p></div></article>
          <article class="engine-card"><div class="engine-icon">✦</div><div><span class="engine-state muted">Optional</span><strong>Text Cleanup</strong><p id="cleanup-route">Off · original transcript is preserved</p></div></article>
        </div>
      </section>

      <section class="page" id="page-appearance">
        <header class="page-header"><div><p class="eyebrow">Appearance</p><h1>Design every moment</h1><p>Choose what the pill shows while it waits, listens, processes, and finishes.</p></div><button class="button" id="reset-appearance" type="button">Restore Defaults</button></header>
        <div class="appearance-presets" role="radiogroup" aria-label="Appearance preset">
          <span>Theme</span>
          <button class="appearance-preset" type="button" role="radio" data-appearance-preset="system"><strong>System</strong></button>
          <button class="appearance-preset" type="button" role="radio" data-appearance-preset="graphite"><strong>Graphite</strong></button>
          <button class="appearance-preset" type="button" role="radio" data-appearance-preset="contrast"><strong>Contrast</strong></button>
          <button class="appearance-preset" type="button" role="radio" data-appearance-preset="custom"><strong>Custom</strong></button>
        </div>
        <div class="appearance-preview" id="appearance-preview">
          <div class="appearance-screen-label"><span>LIVE PREVIEW</span><strong id="appearance-state-label">Listening</strong></div>
          <div class="pill-cluster appearance-pill-cluster listening" id="appearance-pill-cluster">
            <div class="voice-pill listening appearance-pill" id="appearance-pill" role="img" aria-label="Customized pill preview"><span class="pill-content"></span></div>
            <button class="pill-cancel-detached" id="appearance-pill-cancel" type="button" aria-label="Cancel transcription preview" aria-hidden="true" disabled>${navIcon("M7 7l10 10M17 7 7 17")}</button>
          </div>
          <div class="appearance-preview-states" aria-label="Choose pill moment">
            <button type="button" data-preview-state="idle">Ready</button>
            <button class="active" type="button" data-preview-state="listening">Listening</button>
            <button type="button" data-preview-state="working">Processing</button>
            <button type="button" data-preview-state="success">Inserted</button>
            <button type="button" data-preview-state="error">Error</button>
          </div>
        </div>
        <details class="appearance-advanced" open><summary>Advanced pill customization</summary><div class="customization-grid">
          <section class="customization-card position-card">
            <div class="customization-head"><div><p class="setting-kicker">Global</p><h2>Placement</h2><p>Shared by every pill moment.</p></div><output id="pill-position-label">Bottom center</output></div>
            <div class="position-picker" id="position-picker" aria-label="Pill screen position">
              ${["top-left", "top-center", "top-right", "center-left", "center", "center-right", "bottom-left", "bottom-center", "bottom-right"].map((position) => `<button type="button" data-pill-position="${position}" aria-label="${position.replace("-", " ")}"><i></i></button>`).join("")}
            </div>
            <label class="range-setting"><span><strong>Screen margin</strong><output id="pill-margin-value">18 px</output></span><input id="pill-margin" type="range" min="4" max="80" step="1" value="18" /></label>
            <div class="size-setting"><span><strong>Pill size</strong><output id="pill-scale-value">82%</output></span><div class="size-presets" role="group" aria-label="Pill size"><button type="button" data-pill-scale="0.68">Small</button><button type="button" data-pill-scale="0.82">Compact</button><button type="button" data-pill-scale="1">Regular</button></div></div>
            <label class="range-setting exact-size"><span><strong>Exact size</strong><small>Drag to fine-tune</small></span><input id="pill-scale" type="range" min="55" max="130" step="1" value="82" aria-label="Exact pill size" /></label>
            <div class="listening-layout-setting"><span><strong>Listening pill</strong><small>Compact, or expanded with live text and controls.</small></span><div class="listening-layout-picker" role="radiogroup" aria-label="Listening pill layout"><button type="button" role="radio" data-listening-layout="compact">Compact</button><button type="button" role="radio" data-listening-layout="expanded">Expanded</button></div></div>
          </section>
          <section class="customization-card behavior-card state-editor">
            <div class="customization-head"><div><p class="setting-kicker">This moment only</p><h2 id="state-editor-title">Listening</h2><p id="state-editor-description">Customize what appears while your microphone is active.</p></div><span class="state-scope-badge">Independent</span></div>
            <h3>Content</h3>
            <div class="pill-content-picker" role="group" aria-label="Pill content">
              <button type="button" data-pill-content="waveform"><span class="content-waveform">${brandWaveformMarkup()}</span><strong>Living waves</strong><small>Layered + sound</small></button>
              <button type="button" data-pill-content="levels"><span class="content-levels"><i></i><i></i><i></i><i></i></span><strong>Classic bars</strong><small>Audio levels</small></button>
              <button type="button" data-pill-content="status"><span class="content-status">Listening…</span><strong>Status</strong><small>Short state label</small></button>
              <button type="button" data-pill-content="transcript"><span class="content-transcript">Meet at 15:00</span><strong>Text</strong><small>Transcript when ready</small></button>
            </div>
            <p class="pill-content-help" id="pill-content-help">Animated levels respond to your microphone.</p>
            <section class="wave-effect-editor" id="wave-effect-editor" aria-label="Living wave effect">
              <div class="wave-effect-heading"><div><h3>Wave effect</h3><p>Shared by every moment using Living waves.</p></div><span>Global</span></div>
              <div class="wave-color-row">
                <label class="color-setting"><input type="color" data-wave-color="startColor" /><span><strong>Start</strong><output data-wave-color-value="startColor"></output></span></label>
                <label class="color-setting"><input type="color" data-wave-color="middleColor" /><span><strong>Middle</strong><output data-wave-color-value="middleColor"></output></span></label>
                <label class="color-setting"><input type="color" data-wave-color="endColor" /><span><strong>End</strong><output data-wave-color-value="endColor"></output></span></label>
              </div>
              <label class="select-setting"><span><strong>Number of lines</strong><small>More lines create a denser wave.</small></span><select id="wave-line-count"><option value="7">7 lines</option><option value="9">9 lines</option><option value="11">11 lines</option><option value="13">13 lines</option></select></label>
              <div class="wave-effect-ranges">
                <label class="range-setting"><span><strong>Line thickness</strong><output data-wave-effect-value="thickness">62%</output></span><input data-wave-effect="thickness" type="range" min="40" max="140" step="1" value="62" /></label>
                <label class="range-setting"><span><strong>Separation</strong><output data-wave-effect-value="separation">122%</output></span><input data-wave-effect="separation" type="range" min="55" max="180" step="1" value="122" /></label>
                <label class="range-setting"><span><strong>Voice reaction</strong><output data-wave-effect-value="reactivity">120%</output></span><input data-wave-effect="reactivity" type="range" min="50" max="180" step="1" value="120" /></label>
                <label class="range-setting"><span><strong>Motion speed</strong><output data-wave-effect-value="speed">100%</output></span><input data-wave-effect="speed" type="range" min="50" max="180" step="1" value="100" /></label>
              </div>
            </section>
            <label class="toggle-setting state-indicator-toggle"><span><strong>State indicator</strong><small>Show the dot, progress mark, check, or warning.</small></span><input id="pill-state-indicator" type="checkbox" checked /><i aria-hidden="true"></i></label>
            <h3>Color & depth</h3>
            <div class="state-color-row">
              <label class="color-setting"><input type="color" data-state-color="background" /><span><strong>Surface</strong><output data-state-color-value="background"></output></span></label>
              <label class="color-setting"><input type="color" data-state-color="text" /><span><strong>Text</strong><output data-state-color-value="text"></output></span></label>
              <label class="color-setting"><input type="color" data-state-color="accent" /><span><strong>Accent</strong><output data-state-color-value="accent"></output></span></label>
            </div>
            <label class="range-setting"><span><strong>Surface opacity</strong><output id="pill-opacity-value">96%</output></span><input id="pill-opacity" type="range" min="45" max="100" step="1" value="96" /></label>
            <label class="range-setting"><span><strong>Shadow</strong><output id="pill-shadow-value">38%</output></span><input id="pill-shadow" type="range" min="0" max="70" step="1" value="38" /></label>
          </section>
          <section class="appearance-accessibility"><span id="appearance-contrast-icon">✓</span><div><strong>Readability check</strong><p class="appearance-contrast-status" id="appearance-contrast-status" role="status"></p></div></section>
        </div></details>
        <p class="appearance-status" id="appearance-status" aria-live="polite">Your choices are stored locally and applied instantly.</p>
      </section>

      <section class="page" id="page-history">
        <header class="page-header"><div><p class="eyebrow">History</p><h1>Recordings and transcripts</h1><p>Review saved dictations. Everything in History stays on this computer.</p></div><span class="status-badge">Stored on this computer</span></header>
        <div class="history-layout">
          <aside class="recording-library"><div class="library-head"><div><strong>Recordings</strong><span id="history-count">${recordingHistory.length}</span></div><button class="text-button danger" id="delete-all-recordings" type="button" disabled>Delete all</button></div><label class="history-search"><span class="sr-only">Search history</span><input id="history-search" type="search" placeholder="Search transcripts" autocomplete="off" /></label><div id="history-list"></div></aside>
          <div class="history-stage">
            <div class="recording-detail"><div><span>Transcript</span><strong id="history-word-count">0 words</strong></div><p id="history-transcript" dir="auto">Recording history is off by default. Turn it on in Privacy to save audio and transcripts.</p><div class="recording-detail-actions"><button class="text-button" id="history-recording-settings" data-page-link="privacy" type="button">Open Recording Settings</button><button class="text-button" id="copy-transcript" disabled>Copy Transcript</button><button class="button danger-action" id="delete-recording" disabled>Delete Recording</button></div><p class="history-action-status" id="history-action-status" aria-live="polite"></p></div>
            <div class="cassette-shell" id="history-cassette" aria-label="Selected recording player" hidden>
              <i class="cassette-screw top-left"></i><i class="cassette-screw top-right"></i><i class="cassette-screw bottom-left"></i><i class="cassette-screw bottom-right"></i>
              <div class="cassette-label">
                <div class="cassette-heading"><div><span id="cassette-archive">LOCAL ARCHIVE</span><strong id="cassette-title">No recordings yet</strong></div><div class="cassette-side"><b>SIDE A</b><span id="cassette-code">READY</span></div></div>
                <div class="cassette-stripes"><i></i><i></i><i></i></div>
                <div class="cassette-tape">
                  <span class="tape-path" aria-hidden="true"></span>
                  <span class="cassette-reel left"><span class="tape-pack"></span><i></i></span>
                  <span class="tape-window"><span class="tape-glint"></span><span class="tape-motion"></span></span>
                  <span class="cassette-reel right"><span class="tape-pack"></span><i></i></span>
                </div>
                <div class="cassette-timeline"><input id="history-progress" type="range" min="0" max="1" step="0.01" value="0" aria-label="Recording position" disabled><div><time id="history-elapsed">0:00</time><time id="history-total">0:00</time></div></div>
              </div>
              <div class="cassette-controls"><button class="transport-control" id="history-rewind" aria-label="Rewind 5 seconds. Hold to scrub backward"><span>↶</span><small>5</small></button><button class="play-control" id="history-play" aria-label="Play recording"><span></span></button><button class="transport-control" id="history-forward" aria-label="Forward 5 seconds. Hold to scrub forward"><span>↷</span><small>5</small></button><button id="history-mute" aria-label="Mute recording">◖</button></div>
            </div>
            <div class="deck-meter" id="history-deck-meter" aria-label="Playback level" hidden><div class="deck-meter-label"><span>INPUT LEVEL</span><output id="history-db">−∞ dB</output></div><div class="db-track" id="history-db-track">${Array.from({ length: 18 }, (_, index) => `<i style="--segment:${index}"></i>`).join("")}</div><strong id="history-transport-state">STOPPED</strong></div>
            <p class="history-disclosure">Saved audio and transcripts stay on this computer until you delete them.</p>
          </div>
        </div>
      </section>

      <section class="page" id="page-providers">
        <header class="page-header"><div><p class="eyebrow">Optional</p><h1>Text Cleanup</h1><p>Improve a transcript before it is inserted. Audio is never sent to a cleanup provider.</p></div></header>
        <div class="security-callout"><span>⌾</span><div><strong>Keys are stored by the operating system</strong><p>They never enter settings files, localStorage, logs, or crash reports.</p></div></div>
        <div class="cleanup-preference"><div><strong>Cleanup after dictation</strong><p id="cleanup-privacy-route">Off keeps the original transcript on this computer.</p></div><select id="active-cleanup"><option value="off">Off</option><option value="local">Local model</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Google Gemini</option><option value="bedrock">Amazon Bedrock</option></select></div>
        <div class="cleanup-preference"><div><strong>Spoken list style</strong><p>Clear sequences such as “one, milk; two, bread; three, apples” become a list on this computer.</p></div><select id="list-style" aria-label="Spoken list style"><option value="numbers">Numbers · 1. 2. 3.</option><option value="letters">Letters · A. B. C.</option><option value="dashes">Dashes · -</option><option value="dots">Dots · •</option></select></div>
        <div class="provider-grid" id="provider-grid"></div>
        <details class="ai-behavior-disclosure"><summary>Advanced Cleanup Settings</summary><section class="ai-behavior-card">
          <div class="ai-behavior-head"><div><p class="eyebrow">Editing behavior</p><h2>Model and cleanup prompt</h2><p>These instructions are used for live dictation and the preview below.</p></div><span class="status-badge">Local preference</span></div>
          <label class="active-model-field">Active model<input id="active-model" type="text" autocomplete="off" spellcheck="false" /><small id="active-model-help">Choose a cleanup provider first.</small></label>
          <label class="prompt-field">Cleanup instructions<textarea id="cleanup-prompt" maxlength="12000" spellcheck="true"></textarea></label>
          <div class="prompt-footer"><span id="prompt-count">0 / 12,000</span><div><button class="button" id="reset-cleanup-prompt" type="button">Restore Default Instructions</button><button class="button primary" id="save-ai-behavior" type="button">Save Cleanup Settings</button></div></div>
          <p class="ai-behavior-status" id="ai-behavior-status" aria-live="polite"></p>
        </section></details>
        <div class="section-title"><div><h2>Cleanup preview</h2><p>Use a local endpoint or any configured cloud provider.</p></div></div>
        <div class="preview-panel">
          <label for="preview-input">Original transcript</label>
          <textarea id="preview-input">I need us to meet at 16:00… um no, at 17:00. Agenda: launch issues, pricing, and next steps.</textarea>
          <div class="preview-fields"><label>Provider<select id="preview-provider"><option value="local">Local model</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Google Gemini</option><option value="bedrock">Amazon Bedrock</option></select></label><label>Model<input id="preview-model" value="qwen3:4b" autocomplete="off" /></label><label>Local base URL<input id="preview-url" value="http://127.0.0.1:11434" autocomplete="off" /></label><label>AWS region<input id="preview-region" value="us-east-1" autocomplete="off" disabled /></label></div>
          <div class="preview-actions"><button class="button primary" id="run-cleanup">Test Cleanup</button><span id="cleanup-status">No test run yet.</span></div>
          <output id="preview-output" aria-live="polite"></output>
        </div>
      </section>

      <section class="page" id="page-stats">
        <header class="page-header"><div><p class="eyebrow">On this computer</p><h1>Statistics</h1><p>See how much you dictate. Measured totals stay on this computer; time saved and provider cost are estimates.</p></div><button class="button" id="reset-stats" type="button">Reset Statistics</button></header>
        <div class="empty-state" id="stats-empty" hidden><strong>Your statistics will appear here</strong><span>Complete your first dictation to start tracking words and dictation time on this computer.</span></div>
        <div class="stats-grid" id="stats-summary">
          <article class="stat-card"><span>Dictation time</span><strong id="stat-dictation-time">0m</strong><small id="stat-dictation-count">0 dictations</small></article>
          <article class="stat-card"><span>Words dictated</span><strong id="stat-words">0</strong><small id="stat-words-rate">— words/minute</small></article>
          <article class="stat-card"><span>Estimated time saved</span><strong id="stat-time-saved">0m</strong><small>Compared with typing at 40 WPM</small></article>
          <article class="stat-card estimated-stat"><span>Estimated provider cost</span><strong id="stat-api-cost">$0.0000</strong><small id="stat-api-calls">0 cloud cleanup calls</small></article>
        </div>
        <section class="stats-panel" id="provider-usage-panel">
          <div class="stats-panel-head"><div><h2>Provider usage</h2><p>Actual token counts returned by each cleanup API.</p></div><span class="status-badge">Stored locally</span></div>
          <div class="usage-table" id="usage-table"></div>
        </section>
        <details class="stats-advanced" id="estimate-settings"><summary>Estimate Settings</summary><section class="stats-panel pricing-panel">
          <div class="stats-panel-head"><div><h2>Cost estimate settings</h2><p>Prices change. Set the paid rate for the exact model, or mark your key as free tier.</p></div></div>
          <div class="pricing-fields"><label>Provider<select id="pricing-provider"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Google Gemini</option><option value="bedrock">Amazon Bedrock</option></select></label><label>Model<input id="pricing-model" type="text" autocomplete="off" spellcheck="false" /></label><label>Input $ / 1M tokens<input id="pricing-input" type="number" min="0" step="0.01" /></label><label>Output $ / 1M tokens<input id="pricing-output" type="number" min="0" step="0.01" /></label></div>
          <label class="free-tier-setting"><input id="pricing-free-tier" type="checkbox" /><span><strong>Free tier</strong><small>Show $0 while this provider key is not billed.</small></span></label>
          <div class="pricing-actions"><button class="button primary" id="save-pricing" type="button">Save estimate settings</button><span id="pricing-status" aria-live="polite">Rates apply only to local estimates.</span></div>
        </section></details>
      </section>

      <section class="page" id="page-dictionary">
        <header class="page-header"><div><p class="eyebrow">Personalization</p><h1>Teach Indoor Voice your language</h1><p>Save spelling, reusable phrases, and app-specific behavior. Everything here stays on this computer.</p></div></header>
        <section class="personalization-section"><div class="section-title"><div><h2>Dictionary</h2><p>Correct names, products, Hebrew terms, and technical vocabulary after local transcription.</p></div><div class="section-actions"><button class="button" id="import-dictionary">Import</button><button class="button" id="export-dictionary">Export</button><button class="button primary" id="add-word">Add word</button></div></div><div class="dictionary-list" id="dictionary-list"></div></section>
        <section class="personalization-section"><div class="section-title"><div><h2>Snippets</h2><p>Speak a trigger such as “my email” to insert a saved expansion.</p></div><button class="button primary" id="add-snippet">Add snippet</button></div><div class="dictionary-list" id="snippet-list"></div></section>
        <section class="personalization-section"><div class="section-title"><div><h2>App profiles</h2><p>Choose language and cleanup behavior automatically for specific apps.</p></div><button class="button primary" id="add-app-profile">Add profile</button></div><div class="dictionary-list" id="app-profile-list"></div></section>
      </section>

      <section class="page" id="page-privacy">
        <header class="page-header"><div><p class="eyebrow">Security boundary</p><h1>Privacy</h1><p>Indoor Voice begins with the strictest policy and requires explicit choices to send transcript text elsewhere.</p></div></header>
        <div class="settings-card"><h2>Keyboard</h2><div class="setting-row"><div><strong>Dictation shortcut</strong><p id="shortcut-settings-status" aria-live="polite">Hold the shortcut while speaking, then release to transcribe.</p></div><button class="shortcut-recorder shortcut-change" type="button"><kbd id="shortcut-settings-label">⌥ Space</kbd><span>Change</span></button></div><div class="setting-row"><div><strong>Input mode</strong><p>Use classic push-to-talk or press once to start and again to stop.</p></div><select id="input-mode"><option value="ptt">Push-to-talk · hold</option><option value="toggle">Hands-free · tap</option></select></div></div>
        <div class="settings-card"><h2>Audio</h2><div class="setting-row"><div><strong>Transcription engine</strong><p>Choose speed or accuracy. Audio always remains on this Mac.</p></div><select id="transcription-model" aria-label="Transcription quality"><option value="fast">Fast · Whisper Base</option><option value="balanced">Balanced · Whisper Small</option><option value="best">Best accuracy · Whisper Medium</option></select></div><div class="setting-row"><div><strong>Microphone</strong><p id="microphone-help">Use the system default or choose a specific input.</p></div><div class="inline-settings"><select id="microphone-device" aria-label="Microphone"><option value="">System default</option></select><button class="button" id="test-microphone" type="button">Test</button></div></div><div class="setting-row language-setting-row"><div><strong>Spoken language</strong><p id="dictation-language-help">Smart bilingual detection compares English and Hebrew directly for every dictation.</p></div><select id="dictation-language" aria-label="Spoken language"><option value="en-he">English / עברית · Smart detection</option><option value="en">English only</option><option value="he">עברית בלבד</option><option value="auto">Any language · Automatic</option></select></div><div class="setting-row"><div><strong>Voice detection</strong><p>Reject silence and steady background noise before Whisper runs.</p></div><select id="voice-detection" aria-label="Voice detection"><option value="balanced">Balanced</option><option value="noisy">Noisy room</option><option value="sensitive">Quiet voice</option></select></div><div class="setting-row"><div><strong>Live text preview</strong><p>Show partial text while speaking. Disable it on slower Macs for the fastest final result.</p></div><button class="switch on" id="live-preview-toggle" type="button" role="switch" aria-checked="true" aria-label="Live text preview is on"></button></div><div class="setting-row"><div><strong>Recording history</strong><p>Choose whether audio and transcripts appear in your local archive.</p></div><select id="audio-retention" aria-label="Recording history"><option value="never">Never save recordings</option><option value="day">Delete after 24 hours</option><option value="week">Delete after 7 days</option><option value="keep">Keep until I delete it</option></select></div></div>
        <div class="settings-card"><h2>Text insertion</h2><div class="setting-row"><div><strong>Smart spacing</strong><p>Reads only the single character before the cursor, locally, to avoid joined sentences or double spaces.</p></div><button class="switch on" id="smart-spacing-toggle" type="button" role="switch" aria-checked="true" aria-label="Smart spacing is on"></button></div><div class="setting-row"><div><strong>Voice formatting commands</strong><p>Recognize “new line,” “new paragraph,” punctuation, and Hebrew equivalents locally.</p></div><button class="switch on" id="voice-commands-toggle" type="button" role="switch" aria-checked="true" aria-label="Voice formatting commands are on"></button></div></div>
        <div class="settings-card"><h2>System</h2><div class="setting-row"><div><strong>Launch at login</strong><p>Keep the global shortcut ready after you sign in.</p></div><button class="switch" id="launch-at-login-toggle" type="button" role="switch" aria-checked="false" aria-label="Launch at login is off"></button></div><div class="setting-row"><div><strong>Indoor Voice diagnostic</strong><p id="diagnostic-status">Check model, microphone, permissions, and local inference readiness.</p></div><button class="button" id="run-diagnostic" type="button">Run Test</button></div><div class="setting-row"><div><strong>Software updates</strong><p id="release-status">Checking release configuration…</p></div><button class="button" id="check-updates" type="button">Check</button></div></div>
        <div class="boundary"><div><span>Microphone audio</span><strong>On this computer</strong></div><i>→</i><div><span>Original transcript</span><strong>Optional Text Cleanup</strong></div><i>→</i><div><span>Finished text</span><strong>Focused app</strong></div></div>
      </section>
    </main>
  </div>

  <dialog id="provider-dialog">
    <form method="dialog" id="provider-form">
      <div class="dialog-head"><div><p class="eyebrow">Secure configuration</p><h2 id="dialog-title">Configure provider</h2></div><button class="icon-button" value="cancel" aria-label="Close">×</button></div>
      <input type="hidden" id="provider-id" />
      <label id="key-field">API key<input type="password" id="provider-key" autocomplete="off" spellcheck="false" placeholder="Paste once — it will not be shown again" /></label>
      <label>Default model<input type="text" id="provider-model" autocomplete="off" /></label>
      <label id="base-url-field">Base URL<input type="url" id="provider-url" autocomplete="off" value="http://127.0.0.1:11434" /></label>
      <label id="region-field">AWS region<input type="text" id="provider-region" autocomplete="off" value="us-east-1" /></label>
      <div class="dialog-security">The secret is sent directly to the native vault and cleared from this form after saving.</div>
      <p class="form-error" id="provider-error" role="alert"></p>
      <div class="dialog-actions"><button class="button" value="cancel">Cancel</button><button class="button primary" id="save-provider" value="default">Save securely</button></div>
    </form>
  </dialog>

  <dialog id="shortcut-dialog" aria-labelledby="shortcut-dialog-title">
    <form method="dialog" id="shortcut-form">
      <div class="dialog-head"><div><p class="eyebrow">Keyboard shortcut</p><h2 id="shortcut-dialog-title">Press a new shortcut</h2></div><button class="icon-button" value="cancel" aria-label="Cancel shortcut change">×</button></div>
      <button class="shortcut-capture-surface" id="shortcut-capture-surface" type="button">
        <span>Listening for keys</span>
        <kbd id="shortcut-capture-label">Press shortcut…</kbd>
      </button>
      <div class="shortcut-presets" aria-label="Suggested two-key shortcuts"><span>Two-key choices</span><button type="button" data-shortcut-preset="Alt+Space">⌥ Space</button><button type="button" data-shortcut-preset="Control+Space">⌃ Space</button><button type="button" data-shortcut-preset="Alt+KeyD">⌥ D</button></div>
      <p class="shortcut-help">Choose above, or hold Command, Control, or Option and press one other key. Press Esc to cancel.</p>
      <p class="form-error" id="shortcut-capture-status" role="alert" aria-live="assertive"></p>
      <div class="dialog-actions"><button class="button" value="cancel">Cancel</button></div>
    </form>
  </dialog>

  <dialog id="delete-recording-dialog" aria-labelledby="delete-recording-title">
    <form method="dialog">
      <div class="dialog-head"><div><p class="eyebrow">Local archive</p><h2 id="delete-recording-title">Delete recording?</h2></div><button class="icon-button" value="cancel" aria-label="Cancel deletion">×</button></div>
      <p class="delete-recording-copy" id="delete-recording-copy">This removes the audio and transcript from this computer.</p>
      <p class="form-error" id="delete-recording-error" role="alert"></p>
      <div class="dialog-actions"><button class="button" value="cancel">Cancel</button><button class="button danger-action" id="confirm-delete-recording" type="button">Delete permanently</button></div>
    </form>
  </dialog>
`;

const pill = document.querySelector<HTMLDivElement>("#voice-pill")!;
const pillContent = pill.querySelector<HTMLElement>(".pill-content")!;
const pillCluster = document.querySelector<HTMLDivElement>("#voice-pill-cluster")!;
const pillCancel = document.querySelector<HTMLButtonElement>("#voice-pill-cancel")!;
const insertedText = document.querySelector<HTMLParagraphElement>("#inserted-text")!;
const demoMessage = document.querySelector<HTMLParagraphElement>("#demo-message")!;
const providerDialog = document.querySelector<HTMLDialogElement>("#provider-dialog")!;
const shortcutDialog = document.querySelector<HTMLDialogElement>("#shortcut-dialog")!;
const shortcutCaptureSurface = document.querySelector<HTMLButtonElement>("#shortcut-capture-surface")!;
const shortcutCaptureLabel = document.querySelector<HTMLElement>("#shortcut-capture-label")!;
const shortcutCaptureStatus = document.querySelector<HTMLParagraphElement>("#shortcut-capture-status")!;
const deleteRecordingDialog = document.querySelector<HTMLDialogElement>("#delete-recording-dialog")!;
const deleteRecordingCopy = document.querySelector<HTMLParagraphElement>("#delete-recording-copy")!;
const deleteRecordingError = document.querySelector<HTMLParagraphElement>("#delete-recording-error")!;
const providerKeyInput = document.querySelector<HTMLInputElement>("#provider-key")!;
const providerModelInput = document.querySelector<HTMLInputElement>("#provider-model")!;
const providerUrlInput = document.querySelector<HTMLInputElement>("#provider-url")!;
const providerRegionInput = document.querySelector<HTMLInputElement>("#provider-region")!;
const providerIdInput = document.querySelector<HTMLInputElement>("#provider-id")!;
const providerError = document.querySelector<HTMLParagraphElement>("#provider-error")!;
const keyField = document.querySelector<HTMLElement>("#key-field")!;
const baseUrlField = document.querySelector<HTMLElement>("#base-url-field")!;
const regionField = document.querySelector<HTMLElement>("#region-field")!;
let listening = false;
let selectedRecording = 0;
let recordingPosition = 0;
let recordingPlaying = false;
let tapeStopping = false;
let historyAudio: HTMLAudioElement | undefined;
let historyAudioContext: AudioContext | undefined;
let historyAudioSource: MediaElementAudioSourceNode | undefined;
let historyAnalyser: AnalyserNode | undefined;
let historyLevelData: Float32Array<ArrayBuffer> | undefined;
let playbackFrame: number | undefined;
let tapeStopFrame: number | undefined;
let smoothedDb = -60;
let pendingRecordingDelete: number | "all" | undefined;
let transportDirection: -1 | 0 | 1 = 0;
let transportHeld = false;
let transportHoldTimer: number | undefined;
let transportFrame: number | undefined;
let transportLastFrame = 0;
let shortcutCapturing = false;
let shortcutCaptureHandler: ((event: KeyboardEvent) => void) | undefined;
let activeShortcutAccelerator = /Mac/i.test(navigator.platform) ? "Alt+Space" : "Control+Super+Space";
let modelReady = false;
let captureStarting = false;
let releaseRequested = false;
let microphoneStream: MediaStream | undefined;
let microphoneRecorder: MediaRecorder | undefined;
let microphoneBlobs: Blob[] = [];
let microphoneStartedAt = 0;
let microphoneContext: AudioContext | undefined;
let microphoneSource: MediaStreamAudioSourceNode | undefined;
let microphoneProcessor: ScriptProcessorNode | undefined;
let silentOutput: GainNode | undefined;
let microphoneChunks: Float32Array[] = [];
let microphoneSampleRate = 48_000;
let nativeCaptureActive = false;
let capturePaused = false;
let activeAppIdentity: ForegroundAppIdentity = {};
let microphonePermissionReady = false;
let accessibilityReady = false;
let liveTranscriptTimer: number | undefined;
let liveTranscriptInFlight = false;
let liveTranscriptRun = 0;
let processingRun = 0;
let processingActive = false;
const isDesktopRuntime = "__TAURI_INTERNALS__" in window;
interface PillLevelEvent { level: number }
interface AudioInputDevice { id: string; name: string; isDefault: boolean }
interface DictationControlEvent { action: "toggle" | "pause" | "resume"; paused: boolean; source: "tray" | "app" }
interface DictationControlStatus { paused: boolean; trayAvailable: boolean }
interface LaunchAtLoginStatus { supported: boolean; enabled: boolean; mechanism: string }
interface DiagnosticReport {
  ready: boolean;
  backend: string;
  inputDevices: AudioInputDevice[];
  selectedInputDevice?: string;
  defaultInputDevice?: string;
  accessibilityGranted: boolean;
  captureError?: string;
  notes: string[];
  model: ModelStatus;
}
interface ReleaseDiagnostics {
  version: string;
  architecture: string;
  updateChecksEnabled: boolean;
  productionReleaseReady: boolean;
  releaseBlockers: string[];
}
interface UpdateCheckResult {
  configured: boolean;
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
}
type InputMode = "ptt" | "toggle";
type VoiceDetectionMode = "balanced" | "noisy" | "sensitive";
type DictationLanguage = "en" | "he" | "en-he" | "auto";
let activeCaptureMode: InputMode = "ptt";
let dictationPaused = false;
let pillCustomization = loadPillCustomization();
type AppearancePreset = "system" | "graphite" | "contrast" | "custom";
let appearancePreset = (localStorage.getItem("indoor-voice:appearance-preset") as AppearancePreset | null) ?? "custom";
let currentPillState: PillState = "idle";
let currentPillMessage: string | undefined;
let appearancePreviewState: PillState = "listening";
let previousAppearancePreviewState: PillState = appearancePreviewState;
let selectedCustomizationState: CustomizablePillState = "listening";
const pillGeometryAnimations = new WeakMap<HTMLElement, Animation>();

function beginPillGeometryTransition(element: HTMLElement): DOMRect {
  const currentRect = element.getBoundingClientRect();
  pillGeometryAnimations.get(element)?.cancel();
  pillGeometryAnimations.delete(element);
  return currentRect;
}

function pillGeometryFrames(fromWidth: number, fromHeight: number, toWidth: number, toHeight: number): Keyframe[] {
  return Array.from({ length: 29 }, (_, index) => {
    const offset = index / 28;
    const x = 7.2 * offset;
    const progress = 1 - (1 + x) * Math.exp(-x);
    return {
      width: `${fromWidth + (toWidth - fromWidth) * progress}px`,
      height: `${fromHeight + (toHeight - fromHeight) * progress}px`,
      offset,
    };
  }).map((frame, index, frames) => index === frames.length - 1
    ? { width: `${toWidth}px`, height: `${toHeight}px`, offset: 1 }
    : frame);
}

function finishPillGeometryTransition(element: HTMLElement, fromRect: DOMRect): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || fromRect.width < 1 || fromRect.height < 1) return;
  const targetRect = element.getBoundingClientRect();
  const scale = pillCustomization.scale;
  const fromWidth = fromRect.width / scale;
  const fromHeight = fromRect.height / scale;
  const toWidth = targetRect.width / scale;
  const toHeight = targetRect.height / scale;
  if (Math.abs(fromWidth - toWidth) < .5 && Math.abs(fromHeight - toHeight) < .5) return;
  const animation = element.animate(
    pillGeometryFrames(fromWidth, fromHeight, toWidth, toHeight),
    { duration: 420, easing: "linear", fill: "both" },
  );
  pillGeometryAnimations.set(element, animation);
  animation.onfinish = () => {
    if (pillGeometryAnimations.get(element) !== animation) return;
    animation.cancel();
    pillGeometryAnimations.delete(element);
  };
}

function syncSetupActions(): void {
  const download = document.querySelector<HTMLButtonElement>("#download-model")!;
  const microphone = document.querySelector<HTMLButtonElement>("#enable-microphone")!;
  const accessibility = document.querySelector<HTMLButtonElement>("#enable-accessibility")!;
  download.hidden = modelReady;
  microphone.hidden = !modelReady || microphonePermissionReady;
  accessibility.hidden = !modelReady || !microphonePermissionReady || accessibilityReady;
  download.classList.toggle("primary", !modelReady);
  microphone.classList.toggle("primary", modelReady && !microphonePermissionReady);
  accessibility.classList.toggle("primary", modelReady && microphonePermissionReady && !accessibilityReady);
  const complete = modelReady && microphonePermissionReady && accessibilityReady;
  document.querySelector<HTMLElement>("#setup-panel")!.classList.toggle("complete", complete);
  document.querySelectorAll<HTMLElement>(".setup-dependent").forEach((element) => { element.hidden = !complete; });
}

function waveform(): string {
  return `<span class="bars" aria-hidden="true">${[6, 11, 18, 22, 14, 20, 12, 21, 9, 15, 7]
    .map((height, index) => `<i style="--bar:${height}px;--delay:-${index * 0.07}s"></i>`)
    .join("")}</span>`;
}

function pillStateLabel(state: PillState, message?: string): string {
  return message ?? {
    idle: "Ready",
    listening: "Listening",
    handsfree: "Hands-free",
    working: "Transcribing",
    success: "Inserted",
    error: "Try again",
  }[state];
}

function usesExpandedListening(state: PillState): boolean {
  return pillCustomization.listeningLayout === "expanded" && (state === "listening" || state === "handsfree");
}

function appIdentityMarkup(identity: ForegroundAppIdentity = activeAppIdentity): string {
  const name = identity.name?.trim() || "Current app";
  const icon = identity.iconDataUrl?.startsWith("data:image/png;base64,")
    ? `<img src="${identity.iconDataUrl}" alt="" />`
    : `<span aria-hidden="true">${escapeHtml(name.slice(0, 1).toLocaleUpperCase())}</span>`;
  return `<span class="expanded-app-icon" title="${escapeHtml(name)}" aria-label="Dictating into ${escapeHtml(name)}">${icon}</span>`;
}

function expandedListeningMarkup(message: string | undefined, mode: PillContentMode): string {
  const visual = mode === "levels" ? waveform() : brandWaveformMarkup();
  const liveText = capturePaused ? "Paused" : message?.trim() || "Listening…";
  const pauseLabel = capturePaused ? "Resume listening" : "Pause listening";
  const pauseIcon = capturePaused
    ? `<path d="M9 7.3v9.4l7-4.7z" />`
    : `<path d="M9 7v10M15 7v10" />`;
  return `<span class="expanded-listening-shell">
    <strong class="expanded-live-text" dir="auto">${escapeHtml(liveText)}</strong>
    <span class="expanded-listening-row">
      ${appIdentityMarkup()}
      <span class="expanded-listening-visual" aria-hidden="true">${visual}</span>
      <span class="expanded-listening-actions">
        <button class="expanded-pill-action expanded-pause" type="button" data-capture-pause aria-label="${pauseLabel}" aria-pressed="${capturePaused}"><svg viewBox="0 0 24 24" aria-hidden="true">${pauseIcon}</svg></button>
        <button class="expanded-pill-action expanded-cancel" type="button" data-capture-cancel aria-label="Cancel dictation"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 7.5l9 9M16.5 7.5l-9 9" /></svg></button>
      </span>
    </span>
  </span>`;
}

function pillMarkup(state: PillState, message?: string): string {
  const stage = stateCustomization(pillCustomization, state);
  const mode = stage.contentMode;
  if (usesExpandedListening(state)) return expandedListeningMarkup(message, mode);
  const statusLabel = `<span class="pill-label" dir="auto">${escapeHtml(pillStateLabel(state, message))}</span>`;
  const transcriptLabel = `<span class="pill-label transcript-label" dir="auto">${escapeHtml(
    state === "success" && message
      ? message
      : state === "listening" || state === "handsfree"
        ? message ?? "Listening…"
        : state === "error" && message
          ? message
        : state === "working" ? "Processing speech…" : pillStateLabel(state),
  )}</span>`;
  const workingIndicator = stage.showIndicator ? `<span class="dots"><i></i><i></i><i></i></span>` : "";
  const successIndicator = stage.showIndicator ? `<span class="check">✓</span>` : "";
  const errorIndicator = stage.showIndicator ? `<span class="pill-error-mark">!</span>` : "";
  const idleIndicator = stage.showIndicator ? `<span class="idle-glow"></span>` : "";
  const visualOnly = mode === "levels" || mode === "waveform";
  const listeningVisual = mode === "waveform" ? brandWaveformMarkup() : waveform();
  const listeningContent =
    visualOnly
      ? listeningVisual
      : mode === "transcript" ? transcriptLabel : statusLabel;
  const workingVisual = mode === "waveform" ? brandWaveformMarkup() : workingIndicator;
  const workingContent = visualOnly ? workingVisual : `${workingIndicator}${mode === "transcript" ? transcriptLabel : `<span class="pill-label">Transcribing…</span>`}`;
  const successContent = `${successIndicator}${visualOnly ? "" : mode === "transcript" ? transcriptLabel : statusLabel}`;
  const states: Record<PillState, string> = {
    idle: visualOnly ? idleIndicator : mode === "transcript" ? transcriptLabel : statusLabel,
    listening: listeningContent,
    handsfree: listeningContent,
    working: workingContent,
    success: successContent,
    error: `${errorIndicator}${visualOnly ? "" : mode === "transcript" ? transcriptLabel : statusLabel}`,
  };
  return states[state];
}

function setPillState(state: PillState, message?: string): void {
  if (state === currentPillState && usesExpandedListening(state) && !capturePaused && message) {
    const liveText = pillContent.querySelector<HTMLElement>(".expanded-live-text");
    const pauseButton = pillContent.querySelector<HTMLElement>("[data-capture-pause]");
    if (liveText && pauseButton?.getAttribute("aria-pressed") === String(capturePaused)) {
      liveText.textContent = message;
      currentPillMessage = message;
      void emit("pill-state", { state, message }).catch(() => {
        // Browser preview has no native event bus.
      });
      return;
    }
  }
  const previousRect = beginPillGeometryTransition(pill);
  const previousState = currentPillState;
  const previousContentMode = pill.dataset.contentMode;
  const stage = stateCustomization(pillCustomization, state);
  const keepsLivingWave = !usesExpandedListening(state) && previousContentMode === "waveform"
    && stage.contentMode === "waveform"
    && pillContent.querySelector(".brand-waveform") !== null
    && (previousState === "listening" || previousState === "handsfree" || previousState === "working")
    && (state === "listening" || state === "handsfree" || state === "working");
  const morphsFromSpinner = currentPillState === "working"
    && state === "success"
    && stateCustomization(pillCustomization, "working").contentMode === "waveform";
  transitionPillContent({
    pill,
    content: pillContent,
    markup: pillMarkup(state, message),
    fromState: previousState,
    toState: state,
    reuseContent: keepsLivingWave,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  });
  currentPillState = state;
  currentPillMessage = message;
  const expandedClass = usesExpandedListening(state) ? " expanded-listening" : "";
  pillCluster.className = `pill-cluster home-pill-cluster ${state}${expandedClass}${morphsFromSpinner ? " spinner-to-success" : ""}`;
  pill.className = `voice-pill ${state}${expandedClass}${capturePaused ? " capture-paused" : ""}${morphsFromSpinner ? " spinner-to-success" : ""}`;
  applyPillCustomization(pillCluster, pillCustomization, state);
  applyPillCustomization(pill, pillCustomization, state);
  pill.dataset.contentMode = stage.contentMode;
  setWaveformMode(pill, pill.dataset.contentMode !== "waveform"
    ? "idle"
    : state === "working" ? "thinking"
      : state === "listening" || state === "handsfree" ? "listening" : "idle");
  pill.setAttribute("aria-label", message ?? `Voice input ${state}`);
  pillCancel.disabled = state !== "working";
  pillCancel.setAttribute("aria-hidden", String(state !== "working"));
  finishPillGeometryTransition(pill, previousRect);
  void emit("pill-state", { state, message }).catch(() => {
    // Browser preview has no native event bus.
  });
}

function updateWaveformLevel(rawLevel: number): void {
  const level = Number.isFinite(rawLevel) ? Math.min(1, Math.max(0, rawLevel)) : 0;
  applyWaveformLevel(pill, level);
  const appearancePreview = document.querySelector<HTMLElement>("#appearance-pill");
  if (appearancePreview) applyWaveformLevel(appearancePreview, level);
}

function stopLiveTranscription(): void {
  liveTranscriptRun += 1;
  if (liveTranscriptTimer !== undefined) window.clearInterval(liveTranscriptTimer);
  liveTranscriptTimer = undefined;
}

async function updateLiveTranscript(run: number): Promise<void> {
  if (!nativeCaptureActive || capturePaused || liveTranscriptInFlight || run !== liveTranscriptRun) return;
  const pillState = activeCaptureMode === "toggle" ? "handsfree" : "listening";
  if (!usesExpandedListening(pillState) && stateCustomization(pillCustomization, pillState).contentMode !== "transcript") return;
  liveTranscriptInFlight = true;
  try {
    const result = await safeInvoke<TranscriptionResult>("preview_active_capture", {
      language: dictationLanguage(),
      profile: transcriptionModelProfile(),
    });
    if (run === liveTranscriptRun && nativeCaptureActive && result.text.trim()) {
      setPillState(pillState, result.text.trim());
    }
  } catch (error) {
    if (run === liveTranscriptRun && nativeCaptureActive) {
      setPillState(pillState, "Hearing you…");
      console.warn("Live transcription preview unavailable", error);
    }
  } finally {
    liveTranscriptInFlight = false;
  }
}

function startLiveTranscription(): void {
  stopLiveTranscription();
  if (!isDesktopRuntime) return;
  const pillState = activeCaptureMode === "toggle" ? "handsfree" : "listening";
  if (localStorage.getItem("indoor-voice:live-preview") === "off" && !usesExpandedListening(pillState)) return;
  if (!usesExpandedListening(pillState) && stateCustomization(pillCustomization, pillState).contentMode !== "transcript") return;
  setPillState(pillState, "Speak…");
  const run = liveTranscriptRun;
  window.setTimeout(() => void updateLiveTranscript(run), 1200);
  liveTranscriptTimer = window.setInterval(() => void updateLiveTranscript(run), 1400);
}

async function cancelProcessing(): Promise<void> {
  if (!processingActive && currentPillState !== "working") return;
  processingRun += 1;
  processingActive = false;
  await safeInvoke("cancel_transcription").catch(() => undefined);
  setPillState("idle");
  demoMessage.textContent = "Processing canceled. Nothing was inserted.";
}

async function setCapturePaused(paused: boolean): Promise<void> {
  if ((!nativeCaptureActive && !microphoneStream) || capturePaused === paused) return;
  try {
    if (nativeCaptureActive) {
      await safeInvoke(paused ? "pause_audio_capture" : "resume_audio_capture");
    } else if (microphoneContext) {
      if (paused) {
        if (microphoneRecorder?.state === "recording") microphoneRecorder.pause();
        await microphoneContext.suspend();
      } else {
        if (microphoneRecorder?.state === "paused") microphoneRecorder.resume();
        await microphoneContext.resume();
      }
    }
    capturePaused = paused;
    const state = activeCaptureMode === "toggle" ? "handsfree" : "listening";
    if (paused) stopLiveTranscription();
    setPillState(state, paused ? "Paused" : currentPillMessage);
    if (!paused) startLiveTranscription();
    void emit("pill-capture-paused", { paused }).catch(() => {
      // Browser preview has no native event bus.
    });
    demoMessage.textContent = paused ? "Listening paused. Your recording is kept." : "Listening resumed…";
  } catch (error) {
    demoMessage.textContent = error instanceof Error ? error.message : "The recording could not be paused.";
  }
}

async function cancelMicrophoneCapture(): Promise<void> {
  if (!nativeCaptureActive && !microphoneStream) return;
  stopLiveTranscription();
  listening = false;
  capturePaused = false;
  void emit("pill-capture-paused", { paused: false }).catch(() => undefined);
  if (nativeCaptureActive) {
    nativeCaptureActive = false;
    await safeInvoke("stop_audio_capture").catch(() => undefined);
  } else {
    await stopMicrophoneRecorder().catch(() => undefined);
    microphoneProcessor?.disconnect();
    microphoneSource?.disconnect();
    silentOutput?.disconnect();
    microphoneStream?.getTracks().forEach((track) => track.stop());
    await microphoneContext?.close().catch(() => undefined);
    microphoneStream = undefined;
    microphoneRecorder = undefined;
    microphoneContext = undefined;
    microphoneSource = undefined;
    microphoneProcessor = undefined;
    silentOutput = undefined;
    microphoneChunks = [];
    microphoneBlobs = [];
  }
  updateWaveformLevel(0);
  setPillState("idle");
  demoMessage.textContent = "Dictation canceled. Nothing was inserted.";
}

function resampleToWhisperRate(input: Float32Array, sourceRate: number): Float32Array {
  const targetRate = 16_000;
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const output = new Float32Array(Math.floor(input.length / ratio));
  for (let index = 0; index < output.length; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.floor((index + 1) * ratio));
    let sum = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) sum += input[sourceIndex];
    output[index] = sum / Math.max(1, end - start);
  }
  return output;
}

function inputMode(): InputMode {
  return (localStorage.getItem("indoor-voice:input-mode") === "toggle" ? "toggle" : "ptt") as InputMode;
}

function voiceDetectionMode(): VoiceDetectionMode {
  const stored = localStorage.getItem("indoor-voice:voice-detection");
  return stored === "noisy" || stored === "sensitive" ? stored : "balanced";
}

function transcriptionModelProfile(): "fast" | "balanced" | "best" {
  if (activeAppProfile?.model === "fast") return "fast";
  if (activeAppProfile?.model === "best") return "best";
  if (activeAppProfile?.model === "balanced") return "balanced";
  const stored = localStorage.getItem("indoor-voice:transcription-model");
  return stored === "balanced" || stored === "best" ? stored : "fast";
}

function dictationLanguage(): DictationLanguage {
  if (activeAppProfile?.language === "en" || activeAppProfile?.language === "he" || activeAppProfile?.language === "auto") {
    return activeAppProfile.language;
  }
  const stored = localStorage.getItem("indoor-voice:language");
  const migrationKey = "indoor-voice:language-choice:v2";
  if (!localStorage.getItem(migrationKey)) {
    const migrated: DictationLanguage = stored === "he" || stored === "auto" ? stored : "en-he";
    localStorage.setItem("indoor-voice:language", migrated);
    localStorage.setItem(migrationKey, "done");
    return migrated;
  }
  return stored === "en" || stored === "he" || stored === "auto" || stored === "en-he" ? stored : "en-he";
}

function validateTranscriptLanguage(text: string, language: DictationLanguage): void {
  if (language === "auto") return;
  const latin = Array.from(text).filter((character) => /[A-Za-z]/.test(character)).length;
  const hebrew = Array.from(text).filter((character) => /[\u0590-\u05ff]/.test(character)).length;
  if (language === "en-he") {
    const otherScript = Array.from(text).filter((character) => /\p{L}/u.test(character) && !/[A-Za-z\u0590-\u05ff]/u.test(character)).length;
    if (otherScript >= 4 && otherScript > latin + hebrew) {
      throw new Error("Whisper detected a language outside English and Hebrew, so the text was not pasted. Choose Any language under Privacy if that was intentional.");
    }
    return;
  }
  if (language === "en" && hebrew >= 4 && hebrew > latin * 0.25) {
    throw new Error("The transcript unexpectedly switched to Hebrew, so it was not pasted. Choose Hebrew or Automatic under Privacy → Spoken language when needed.");
  }
  if (language === "he" && latin >= 8 && hebrew < 4) {
    throw new Error("The transcript unexpectedly switched to English, so it was not pasted. Choose English or Automatic under Privacy → Spoken language when needed.");
  }
}

function normalizeCompactTimes(text: string): string {
  return text.replace(
    /(\b(?:at|by|around|from|until|before|after)\s+)([01]?\d|2[0-3])([0-5]\d)\b/gi,
    (_match, prefix: string, hour: string, minute: string) => `${prefix}${hour.padStart(2, "0")}:${minute}`,
  );
}

function selectedListStyle(): ListStyle {
  return activeAppProfile?.listStyle ?? normalizeListStyle(localStorage.getItem(LIST_STYLE_KEY));
}

function applyLocalFormatting(text: string): string {
  let formatted = normalizeUnicodeText(text);
  const voiceCommandsEnabled = activeAppProfile?.voiceCommandsEnabled
    ?? localStorage.getItem("indoor-voice:voice-commands") !== "off";
  if (voiceCommandsEnabled) {
    formatted = applyVoiceFormattingCommands(formatted, { listStyle: selectedListStyle() });
  } else {
    formatted = formatSpokenLists(formatted, selectedListStyle());
  }
  if (activeAppProfile?.dictionaryEnabled !== false) formatted = applyDictionary(formatted, dictionaryEntries);
  if (activeAppProfile?.snippetsEnabled !== false) formatted = applySnippets(formatted, snippets);
  return normalizeCompactTimes(formatted);
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/u).length : 0;
}

interface SpeechActivityResult {
  speech: Float32Array | undefined;
  capturedSeconds: number;
  speechSeconds: number;
}

function detectSpeechActivity(samples: Float32Array, mode: VoiceDetectionMode): SpeechActivityResult {
  const frameSize = 320;
  const profiles = {
    sensitive: { minimumRms: 0.0025, noiseRatio: 1.55, minimumPeak: 0.008, minimumFrames: 5 },
    balanced: { minimumRms: 0.0038, noiseRatio: 1.8, minimumPeak: 0.012, minimumFrames: 7 },
    noisy: { minimumRms: 0.0055, noiseRatio: 2.2, minimumPeak: 0.018, minimumFrames: 9 },
  } as const;
  const profile = profiles[mode];
  const frames: Array<{ rms: number; peak: number }> = [];
  for (let start = 0; start + frameSize <= samples.length; start += frameSize) {
    let energy = 0;
    let peak = 0;
    for (let index = start; index < start + frameSize; index += 1) {
      const absolute = Math.abs(samples[index]);
      energy += samples[index] * samples[index];
      peak = Math.max(peak, absolute);
    }
    frames.push({ rms: Math.sqrt(energy / frameSize), peak });
  }
  const capturedSeconds = samples.length / 16_000;
  if (!frames.length) return { speech: undefined, capturedSeconds, speechSeconds: 0 };
  const orderedRms = frames.map((frame) => frame.rms).sort((left, right) => left - right);
  const noiseFloor = orderedRms[Math.floor((orderedRms.length - 1) * 0.15)] ?? 0;
  const threshold = Math.max(profile.minimumRms, noiseFloor * profile.noiseRatio);
  const rawActivity = frames.map((frame) => frame.rms >= threshold && frame.peak >= profile.minimumPeak);
  const activity = rawActivity.map((_, index) => {
    let activeNeighbors = 0;
    for (let neighbor = Math.max(0, index - 2); neighbor <= Math.min(rawActivity.length - 1, index + 2); neighbor += 1) {
      if (rawActivity[neighbor]) activeNeighbors += 1;
    }
    return activeNeighbors >= 2;
  });
  const activeIndices = activity.flatMap((active, index) => (active ? [index] : []));
  const firstFrame = activeIndices.at(0);
  const lastFrame = activeIndices.at(-1);
  const speechSpanFrames = firstFrame === undefined || lastFrame === undefined ? 0 : lastFrame - firstFrame + 1;
  const hasSpeech =
    activeIndices.length >= profile.minimumFrames &&
    speechSpanFrames >= 8 &&
    frames.some((frame) => frame.peak >= profile.minimumPeak * 1.25);
  if (!hasSpeech || firstFrame === undefined || lastFrame === undefined) {
    return { speech: undefined, capturedSeconds, speechSeconds: 0 };
  }
  const paddedStart = Math.max(0, (firstFrame - 10) * frameSize);
  const paddedEnd = Math.min(samples.length, (lastFrame + 16) * frameSize);
  return {
    speech: samples.slice(paddedStart, paddedEnd),
    capturedSeconds,
    speechSeconds: (activeIndices.length * frameSize) / 16_000,
  };
}

function collectedMicrophoneAudio(): Float32Array {
  const length = microphoneChunks.reduce((total, chunk) => total + chunk.length, 0);
  const joined = new Float32Array(length);
  let offset = 0;
  for (const chunk of microphoneChunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return resampleToWhisperRate(joined, microphoneSampleRate);
}

function stopMicrophoneRecorder(): Promise<Blob | undefined> {
  const recorder = microphoneRecorder;
  if (!recorder || recorder.state === "inactive") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timeout = window.setTimeout(
      () => resolve(microphoneBlobs.length ? new Blob(microphoneBlobs, { type: recorder.mimeType }) : undefined),
      1200,
    );
    recorder.addEventListener(
      "stop",
      () => {
        window.clearTimeout(timeout);
        resolve(microphoneBlobs.length ? new Blob(microphoneBlobs, { type: recorder.mimeType }) : undefined);
      },
      { once: true },
    );
    recorder.stop();
  });
}

async function decodeRecordedMicrophone(blob: Blob | undefined): Promise<Float32Array | undefined> {
  if (!blob || !microphoneContext) return undefined;
  try {
    const buffer = await microphoneContext.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const samples = buffer.getChannelData(channel);
      for (let index = 0; index < samples.length; index += 1) mono[index] += samples[index] / buffer.numberOfChannels;
    }
    return resampleToWhisperRate(mono, buffer.sampleRate);
  } catch {
    return undefined;
  }
}

async function requestMicrophonePermission(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("#enable-microphone")!;
  button.disabled = true;
  button.textContent = "Requesting Access…";
  try {
    if (isDesktopRuntime) {
      await safeInvoke("start_audio_capture");
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      await safeInvoke("stop_audio_capture");
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    }
    microphonePermissionReady = true;
    button.textContent = "Microphone Allowed";
    button.classList.add("ready");
    syncSetupActions();
  } catch {
    button.textContent = "Allow Microphone";
    button.disabled = false;
  }
}

async function refreshAccessibilityStatus(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("#enable-accessibility")!;
  try {
    const trusted = await safeInvoke<boolean>("accessibility_is_trusted");
    accessibilityReady = trusted;
    button.textContent = trusted ? "Text Insertion Allowed" : "Allow Text Insertion";
    button.classList.toggle("ready", trusted);
    syncSetupActions();
  } catch {
    button.textContent = "Allow Text Insertion";
    syncSetupActions();
  }
}

async function openAccessibilitySettings(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("#enable-accessibility")!;
  try {
    if (await safeInvoke<boolean>("accessibility_is_trusted")) {
      accessibilityReady = true;
      button.textContent = "Text Insertion Allowed";
      button.classList.add("ready");
      syncSetupActions();
      return;
    }
    button.disabled = true;
    button.textContent = "Approve the macOS Prompt…";
    await safeInvoke<boolean>("request_input_permission");
    button.textContent = "In Settings, Toggle Indoor Voice Off and On";
    button.title = "A rebuilt local app can leave an older Indoor Voice permission entry enabled. Toggle it off and on; if that does not work, remove it with − and add this app again with +.";
    demoMessage.textContent = "macOS may still trust an older build. Toggle Indoor Voice off and on in Accessibility. If it remains blocked, remove the entry with − and add this copy again with +.";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      if (await safeInvoke<boolean>("accessibility_is_trusted")) {
        accessibilityReady = true;
        button.disabled = false;
        button.textContent = "Text Insertion Allowed";
        button.classList.add("ready");
        button.title = "";
        syncSetupActions();
        return;
      }
    }
    await safeInvoke("open_accessibility_settings");
    button.disabled = false;
    button.textContent = "Toggle Off and On, Then Return Here";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 500));
      if (await safeInvoke<boolean>("accessibility_is_trusted")) {
        accessibilityReady = true;
        button.textContent = "Text Insertion Allowed";
        button.classList.add("ready");
        button.title = "";
        syncSetupActions();
        return;
      }
    }
    button.textContent = "Open Accessibility Settings Again";
  } catch (error) {
    button.disabled = false;
    button.textContent = error instanceof Error ? error.message : "Open System Settings";
  }
}

async function startMicrophoneCapture(mode: InputMode = inputMode()): Promise<void> {
  if (dictationPaused) {
    demoMessage.textContent = "Dictation is paused. Resume it from the menu bar before speaking.";
    return;
  }
  if (captureStarting || nativeCaptureActive || microphoneStream) return;
  if (!modelReady) {
    setPillState("error", "Download Whisper first");
    demoMessage.textContent = "Download Whisper before you start dictating.";
    window.setTimeout(() => setPillState("idle"), 2200);
    return;
  }
  try {
    const identity = await safeInvoke<ForegroundAppIdentity>("focused_application");
    activeAppIdentity = identity;
    activeAppProfile = resolveAppProfile(appProfiles, identity);
    void emit("pill-app-context", identity).catch(() => {
      // Browser preview has no native event bus.
    });
  } catch {
    activeAppIdentity = {};
    activeAppProfile = undefined;
  }
  activeCaptureMode = mode;
  captureStarting = true;
  releaseRequested = false;
  try {
    microphoneStartedAt = performance.now();
    if (isDesktopRuntime) {
      await safeInvoke("start_audio_capture");
      nativeCaptureActive = true;
    } else {
      microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      microphoneContext = new AudioContext();
      await microphoneContext.resume();
      microphoneSampleRate = microphoneContext.sampleRate;
      microphoneChunks = [];
      microphoneBlobs = [];
      microphoneRecorder = undefined;
      if (typeof MediaRecorder !== "undefined") {
        try {
          const preferredType = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
          microphoneRecorder = preferredType ? new MediaRecorder(microphoneStream, { mimeType: preferredType }) : new MediaRecorder(microphoneStream);
          microphoneRecorder.addEventListener("dataavailable", (event) => {
            if (event.data.size) microphoneBlobs.push(event.data);
          });
          microphoneRecorder.start(200);
        } catch {
          microphoneRecorder = undefined;
        }
      }
      microphoneSource = microphoneContext.createMediaStreamSource(microphoneStream);
      microphoneProcessor = microphoneContext.createScriptProcessor(4096, 1, 1);
      silentOutput = microphoneContext.createGain();
      silentOutput.gain.value = 0.00001;
      microphoneProcessor.onaudioprocess = (event) => {
        const channel = event.inputBuffer.getChannelData(0);
        microphoneChunks.push(new Float32Array(channel));
        let energy = 0;
        for (let index = 0; index < channel.length; index += 16) energy += channel[index] * channel[index];
        const level = Math.min(1, Math.sqrt(energy / Math.ceil(channel.length / 16)) * 7);
        updateWaveformLevel(level);
        void emit("pill-level", { level }).catch(() => {
          // Browser preview has no native event bus.
        });
      };
      microphoneSource.connect(microphoneProcessor);
      microphoneProcessor.connect(silentOutput);
      silentOutput.connect(microphoneContext.destination);
    }
    listening = true;
    capturePaused = false;
    void emit("pill-capture-paused", { paused: false }).catch(() => undefined);
    setPillState(mode === "toggle" ? "handsfree" : "listening");
    startLiveTranscription();
    demoMessage.textContent =
      mode === "toggle"
        ? "Hands-free listening… press the shortcut again to stop."
        : "Push-to-talk… release the shortcut when finished.";
  } catch {
    setPillState("error", "Microphone access needed");
    demoMessage.textContent = "Couldn’t access the microphone. Allow microphone access in System Settings, then try again.";
    window.setTimeout(() => setPillState("idle"), 2600);
  } finally {
    captureStarting = false;
    if (activeCaptureMode === "ptt" && releaseRequested && (nativeCaptureActive || microphoneStream)) void finishMicrophoneCapture(true);
  }
}

async function finishTranscriptionResult(
  result: TranscriptionResult,
  paste: boolean,
  run: number,
  capturedSeconds: number,
): Promise<void> {
  if (run !== processingRun) return;
  validateTranscriptLanguage(result.text, dictationLanguage());
  let finalText = result.text;
  let cleanupWarning = "";
  const cleanupProvider = activeAppProfile?.cleanupPreset ?? localStorage.getItem("indoor-voice:cleanup-provider") ?? "off";
  if (cleanupProvider !== "off") {
    const definition = providers.find((provider) => provider.id === cleanupProvider);
    if (!definition) throw new Error("The selected cleanup provider is unavailable.");
    demoMessage.textContent = `Improving text with ${definition.name}…`;
    try {
      const cleanup = await safeInvoke<CleanupResult>("cleanup_text", {
        request: {
          provider: cleanupProvider,
          model: localStorage.getItem(`indoor-voice:model:${cleanupProvider}`) ?? definition.defaultModel,
          base_url: localStorage.getItem("indoor-voice:local-url") ?? "http://127.0.0.1:11434",
          region: localStorage.getItem("indoor-voice:bedrock-region") ?? "us-east-1",
          transcript: result.text,
          instructions: loadCleanupPrompt(),
        },
      });
      if (run !== processingRun) return;
      validateTranscriptLanguage(cleanup.text, dictationLanguage());
      finalText = cleanup.text;
      recordCleanupUsage(cleanup.usage);
      if (cleanupProvider !== "local") localStorage.setItem(`indoor-voice:key-configured:${cleanupProvider}`, "true");
    } catch (error) {
      cleanupWarning = error instanceof Error ? error.message : "Cleanup was rejected.";
      finalText = result.text;
    }
  }
  finalText = applyLocalFormatting(finalText);
  validateTranscriptLanguage(finalText, dictationLanguage());
  if (result.recording) {
    await safeInvoke("update_recording_transcript", { id: result.recording.id, transcript: finalText });
    if (run !== processingRun) return;
  }
  insertedText.textContent = finalText;
  if (paste) await safeInvoke("insert_text", { text: finalText, smartSpacing: smartSpacingEnabled() });
  if (run !== processingRun) return;
  recordDictationStats(capturedSeconds, finalText);
  processingActive = false;
  document.querySelector<HTMLButtonElement>("#undo-insertion")!.disabled = !paste;
  setPillState("success", finalText);
  demoMessage.textContent = cleanupWarning
    ? `${paste ? "Inserted" : "Kept"} the original transcript. Text Cleanup was skipped: ${cleanupWarning}`
    : paste
      ? "Text inserted in the focused app. Undo is available briefly."
      : "Transcription complete. The text is ready to copy.";
  void loadRecordingHistory();
  window.setTimeout(() => setPillState("idle"), 1300);
}

function showTranscriptionError(error: unknown, run: number): void {
  if (run !== processingRun) return;
  processingActive = false;
  const message = error instanceof Error ? error.message : "Transcription failed.";
  if (message.toLocaleLowerCase().includes("no speech was detected")) {
    setPillState("idle");
    demoMessage.textContent = "No speech detected — nothing was inserted.";
    return;
  }
  setPillState("error", message);
  demoMessage.textContent = message;
  window.setTimeout(() => setPillState("idle"), 2800);
}

async function finishMicrophoneCapture(paste: boolean): Promise<void> {
  if (!nativeCaptureActive && (!microphoneStream || !microphoneContext)) return;
  stopLiveTranscription();
  await safeInvoke("cancel_transcription").catch(() => undefined);
  listening = false;
  capturePaused = false;
  void emit("pill-capture-paused", { paused: false }).catch(() => undefined);
  const elapsedMilliseconds = performance.now() - microphoneStartedAt;
  if (nativeCaptureActive) {
    nativeCaptureActive = false;
    setPillState("working");
    const run = ++processingRun;
    processingActive = true;
    demoMessage.textContent = "Transcribing on this computer…";
    try {
      const result = await safeInvoke<TranscriptionResult>("stop_and_transcribe_audio", {
        request: {
          language: dictationLanguage(),
          saveRecording: (localStorage.getItem("indoor-voice:audio-retention") ?? "never") !== "never",
          profile: transcriptionModelProfile(),
        },
      });
      await finishTranscriptionResult(result, paste, run, result.capturedSeconds ?? elapsedMilliseconds / 1000);
    } catch (error) {
      showTranscriptionError(error, run);
    }
    return;
  }
  let samples: Float32Array;
  {
    const stream = microphoneStream!;
    const context = microphoneContext!;
    const recordedBlob = stopMicrophoneRecorder();
    microphoneProcessor?.disconnect();
    microphoneSource?.disconnect();
    silentOutput?.disconnect();
    const fallbackSamples = collectedMicrophoneAudio();
    stream.getTracks().forEach((track) => track.stop());
    const decodedSamples = await decodeRecordedMicrophone(await recordedBlob);
    samples = decodedSamples && decodedSamples.length > fallbackSamples.length / 2 ? decodedSamples : fallbackSamples;
    await context.close();
    microphoneStream = undefined;
    microphoneRecorder = undefined;
    microphoneContext = undefined;
    microphoneSource = undefined;
    microphoneProcessor = undefined;
    silentOutput = undefined;
    microphoneChunks = [];
    microphoneBlobs = [];
  }
  if (samples.length < 4_000) {
    const message = elapsedMilliseconds > 700 ? "Microphone capture stalled — try again" : "Hold a little longer";
    setPillState("error", message);
    demoMessage.textContent = `${message}. Captured ${(samples.length / 16_000).toFixed(1)} seconds.`;
    window.setTimeout(() => setPillState("idle"), 1700);
    return;
  }
  const activity = detectSpeechActivity(samples, voiceDetectionMode());
  if (!activity.speech) {
    setPillState("error", "Couldn’t hear speech");
    demoMessage.textContent = `Couldn’t hear speech. Try speaking closer to your microphone (${activity.capturedSeconds.toFixed(1)}s checked).`;
    window.setTimeout(() => setPillState("idle"), 1800);
    return;
  }
  setPillState("working");
  const run = ++processingRun;
  processingActive = true;
  demoMessage.textContent = `Transcribing ${activity.speechSeconds.toFixed(1)}s of speech on this computer…`;
  try {
    const result = await safeInvoke<TranscriptionResult>("transcribe_audio", {
      request: {
        samples: Array.from(activity.speech),
        language: dictationLanguage(),
        saveRecording: (localStorage.getItem("indoor-voice:audio-retention") ?? "never") !== "never",
        profile: transcriptionModelProfile(),
      },
    });
    await finishTranscriptionResult(result, paste, run, activity.capturedSeconds);
  } catch (error) {
    showTranscriptionError(error, run);
  }
}

async function loadModelStatus(): Promise<void> {
  const title = document.querySelector("#model-setup-title")!;
  const detail = document.querySelector("#model-setup-detail")!;
  const button = document.querySelector<HTMLButtonElement>("#download-model")!;
  const engineStatus = document.querySelector("#whisper-engine-status")!;
  try {
    const profile = transcriptionModelProfile();
    const status = await safeInvoke<ModelStatus>("whisper_model_status_for_profile", { profile });
    modelReady = status.ready;
    syncSetupActions();
    title.textContent = status.ready ? "Whisper is ready" : "Download Whisper";
    detail.textContent = status.ready
      ? `${status.name} · audio stays on this computer`
      : `${status.name} · ${status.size_mb} MB download`;
    engineStatus.textContent = status.ready ? `Preparing ${status.name} on this computer…` : "Model download required";
    button.disabled = status.ready;
    button.textContent = status.ready ? "Whisper Ready" : `Download Whisper · ${status.size_mb} MB`;
    button.classList.toggle("ready", status.ready);
    if (status.ready) {
      void safeInvoke("preload_whisper_model_for_profile", { profile })
        .then(() => (engineStatus.textContent = `Ready · ${status.quality ?? "local CPU inference"}`))
        .catch(() => (engineStatus.textContent = "Ready · running on this computer"));
    }
  } catch {
    title.textContent = "Desktop build required";
    detail.textContent = "Model setup is available in the packaged application.";
    button.disabled = true;
    syncSetupActions();
  }
}

async function downloadLocalModel(): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>("#download-model")!;
  const progress = document.querySelector<HTMLDivElement>("#model-progress")!;
  const detail = document.querySelector("#model-setup-detail")!;
  button.disabled = true;
  button.textContent = "Downloading…";
  progress.hidden = false;
  try {
    await safeInvoke("download_whisper_model_for_profile", { profile: transcriptionModelProfile() });
    await loadModelStatus();
  } catch (error) {
    button.disabled = false;
    button.textContent = "Try download again";
    detail.textContent = error instanceof Error ? error.message : "Model download failed.";
  }
}

async function safeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new Error(typeof error === "string" ? error : "Native command failed");
  }
}

const defaultShortcutAccelerator = /Mac/i.test(navigator.platform) ? "Alt+Space" : "Control+Super+Space";

function shortcutDisplay(accelerator: string): string {
  const labels: Record<string, string> = {
    alt: /Mac/i.test(navigator.platform) ? "⌥" : "Alt",
    option: "⌥",
    command: "⌘",
    cmd: "⌘",
    super: /Mac/i.test(navigator.platform) ? "⌘" : "Win",
    control: /Mac/i.test(navigator.platform) ? "⌃" : "Ctrl",
    ctrl: /Mac/i.test(navigator.platform) ? "⌃" : "Ctrl",
    shift: "⇧",
    space: "Space",
    arrowup: "↑",
    arrowdown: "↓",
    arrowleft: "←",
    arrowright: "→",
    bracketleft: "[",
    bracketright: "]",
    semicolon: ";",
    quote: "'",
    comma: ",",
    period: ".",
    slash: "/",
    backslash: "\\",
    minus: "−",
    equal: "=",
    backquote: "`",
  };
  const parts = accelerator
    .split("+")
    .map((part) => {
      const lower = part.toLowerCase();
      if (labels[lower]) return labels[lower];
      if (/^key[a-z]$/i.test(part)) return part.slice(3).toUpperCase();
      if (/^digit\d$/i.test(part)) return part.slice(5);
      return part.replace(/^Numpad/i, "Num ");
    });
  if (/Mac/i.test(navigator.platform) && parts.length > 1) {
    return `${parts.slice(0, -1).join("")} ${parts[parts.length - 1]}`;
  }
  return parts.join(" + ");
}

function setShortcutDisplay(accelerator: string): void {
  const display = shortcutDisplay(accelerator);
  document.querySelector("#shortcut-label")!.textContent = display;
  document.querySelector("#shortcut-settings-label")!.textContent = display;
}

function acceleratorFromEvent(event: KeyboardEvent): string | null {
  if (["MetaLeft", "MetaRight", "ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight"].includes(event.code)) {
    return null;
  }
  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push("Command");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return "";
  return [...modifiers, event.code].join("+");
}

function shortcutModifierPreview(event: KeyboardEvent): string {
  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push("Command");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return modifiers.length ? `${shortcutDisplay(modifiers.join("+"))} …` : "Press shortcut…";
}

function setShortcutStatus(message: string): void {
  const homeStatus = document.querySelector<HTMLParagraphElement>("#shortcut-status");
  const settingsStatus = document.querySelector<HTMLParagraphElement>("#shortcut-settings-status");
  if (homeStatus) homeStatus.textContent = message;
  if (settingsStatus) settingsStatus.textContent = message;
}

function finishShortcutCapture(closeDialog = true): void {
  if (shortcutCaptureHandler) {
    window.removeEventListener("keydown", shortcutCaptureHandler, true);
    shortcutCaptureHandler = undefined;
  }
  shortcutCapturing = false;
  document.querySelectorAll<HTMLButtonElement>(".shortcut-change").forEach((button) => {
    button.classList.remove("recording");
    button.setAttribute("aria-pressed", "false");
  });
  if (closeDialog && shortcutDialog.open) shortcutDialog.close("finished");
}

async function commitShortcut(accelerator: string): Promise<void> {
  shortcutCaptureLabel.textContent = shortcutDisplay(accelerator);
  shortcutCaptureStatus.textContent = "Saving…";
  shortcutCaptureSurface.disabled = true;
  try {
    const normalized = await safeInvoke<string>("set_global_shortcut", { accelerator });
    localStorage.setItem("indoor-voice:shortcut", normalized);
    activeShortcutAccelerator = normalized;
    setShortcutDisplay(normalized);
    setShortcutStatus(`${shortcutDisplay(normalized)} is now active everywhere.`);
    finishShortcutCapture();
  } catch (error) {
    shortcutCaptureStatus.textContent = error instanceof Error ? error.message : "That shortcut could not be registered. Try another one.";
    shortcutCaptureLabel.textContent = shortcutDisplay(activeShortcutAccelerator);
  } finally {
    shortcutCaptureSurface.disabled = false;
    if (shortcutDialog.open) shortcutCaptureSurface.focus();
  }
}

function beginShortcutCapture(): void {
  if (shortcutCapturing) return;
  shortcutCapturing = true;
  shortcutCaptureLabel.textContent = "Press shortcut…";
  shortcutCaptureStatus.textContent = "";
  setShortcutStatus("Waiting for a new shortcut…");
  document.querySelectorAll<HTMLButtonElement>(".shortcut-change").forEach((button) => {
    button.classList.add("recording");
    button.setAttribute("aria-pressed", "true");
  });
  shortcutDialog.showModal();
  requestAnimationFrame(() => shortcutCaptureSurface.focus());

  const capture = async (event: KeyboardEvent): Promise<void> => {
    const target = event.target as HTMLElement | null;
    if ((event.code === "Enter" || event.code === "Space") && target?.closest("button:not(#shortcut-capture-surface)")) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.code === "Escape") {
      finishShortcutCapture();
      setShortcutStatus("Shortcut change cancelled. Your previous shortcut is still active.");
      return;
    }
    const accelerator = acceleratorFromEvent(event);
    if (accelerator === null) {
      shortcutCaptureLabel.textContent = shortcutModifierPreview(event);
      return;
    }
    if (!accelerator) {
      shortcutCaptureStatus.textContent = "Add Command, Control, or Option, then press one other key.";
      shortcutCaptureLabel.textContent = "Try again";
      return;
    }
    shortcutCaptureLabel.textContent = shortcutDisplay(accelerator);
    await commitShortcut(accelerator);
  };
  shortcutCaptureHandler = capture;
  window.addEventListener("keydown", capture, true);
}

async function loadCapabilities(): Promise<void> {
  const fallback: PlatformCapabilities = {
    platform: navigator.platform || "Browser preview",
    apple_speech_candidate: /Mac/i.test(navigator.platform),
    apple_foundation_model_candidate: /Mac/i.test(navigator.platform),
    secure_store: "Available in desktop build",
    default_shortcut: /Mac/i.test(navigator.platform) ? "⌥ Space" : "Ctrl + Win",
  };
  let capabilities = fallback;
  try {
    capabilities = await safeInvoke<PlatformCapabilities>("platform_capabilities");
  } catch {
    // The Vite browser preview intentionally runs without the native backend.
  }
  document.querySelector("#platform-badge")!.textContent = `${capabilities.platform} · Local mode`;
  const savedShortcut = localStorage.getItem("indoor-voice:shortcut") ?? defaultShortcutAccelerator;
  activeShortcutAccelerator = savedShortcut;
  setShortcutDisplay(savedShortcut);
  try {
    const normalized = await safeInvoke<string>("set_global_shortcut", { accelerator: savedShortcut });
    activeShortcutAccelerator = normalized;
    setShortcutDisplay(normalized);
  } catch {
    localStorage.removeItem("indoor-voice:shortcut");
    activeShortcutAccelerator = defaultShortcutAccelerator;
    setShortcutDisplay(defaultShortcutAccelerator);
  }
  document.querySelector("#apple-engine-status")!.textContent = capabilities.apple_speech_candidate
    ? "Available on this Mac · not connected in this build"
    : "Not available on this system · Local Whisper is active";
}

async function keyStatus(provider: ProviderId): Promise<boolean> {
  if (provider === "local") return true;
  return (
    localStorage.getItem(`indoor-voice:key-configured:${provider}`) === "true" ||
    localStorage.getItem("indoor-voice:cleanup-provider") === provider
  );
}

async function renderProviders(): Promise<void> {
  const statuses = await Promise.all(providers.map((provider) => keyStatus(provider.id)));
  const grid = document.querySelector<HTMLDivElement>("#provider-grid")!;
  grid.innerHTML = providers
    .map((provider, index) => {
      const configured = statuses[index];
      const status = provider.local ? "Local" : configured ? "Key saved" : "Not configured";
      return `<article class="provider-card">
        <div class="provider-head"><span class="provider-logo">${provider.name.slice(0, 1)}</span><span class="provider-status ${configured ? "ready" : ""}">${status}</span></div>
        <strong>${provider.name}</strong><p>${provider.detail}</p>
        <div class="provider-actions"><button class="button configure-provider" data-provider="${provider.id}">${provider.local ? "Configure" : configured ? "Replace key" : "Add key"}</button>${configured && !provider.local ? `<button class="text-button delete-key" data-provider="${provider.id}">Delete</button>` : ""}</div>
      </article>`;
    })
    .join("");
  bindProviderActions();
}

function bindProviderActions(): void {
  document.querySelectorAll<HTMLButtonElement>(".configure-provider").forEach((button) => {
    button.addEventListener("click", () => {
      const provider = providers.find((item) => item.id === button.dataset.provider)!;
      providerIdInput.value = provider.id;
      providerModelInput.value = localStorage.getItem(`indoor-voice:model:${provider.id}`) ?? provider.defaultModel;
      providerUrlInput.value = localStorage.getItem("indoor-voice:local-url") ?? "http://127.0.0.1:11434";
      providerRegionInput.value = localStorage.getItem("indoor-voice:bedrock-region") ?? "us-east-1";
      providerKeyInput.value = "";
      providerError.textContent = "";
      document.querySelector("#dialog-title")!.textContent = `Configure ${provider.name}`;
      keyField.hidden = provider.local;
      baseUrlField.hidden = !provider.local;
      regionField.hidden = provider.id !== "bedrock";
      providerDialog.showModal();
    });
  });
  document.querySelectorAll<HTMLButtonElement>(".delete-key").forEach((button) => {
    button.addEventListener("click", async () => {
      const provider = button.dataset.provider as ProviderId;
      if (!window.confirm(`Delete the saved ${provider} credential from the system vault?`)) return;
      await safeInvoke("delete_provider_key", { provider });
      localStorage.removeItem(`indoor-voice:key-configured:${provider}`);
      await renderProviders();
    });
  });
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

function updateDbMeter(db = -60): void {
  const normalized = Math.min(1, Math.max(0, (db + 60) / 60));
  const activeSegments = Math.round(normalized * 18);
  document.querySelectorAll<HTMLElement>("#history-db-track i").forEach((segment, index) => {
    segment.classList.toggle("active", index < activeSegments);
  });
  const output = document.querySelector<HTMLOutputElement>("#history-db")!;
  output.value = db <= -59.5 ? "−∞ dB" : `${Math.round(db)} dB`;
}

function updatePlaybackVisuals(): void {
  const recording = recordingHistory[selectedRecording];
  if (!recording) return;
  const progress = document.querySelector<HTMLInputElement>("#history-progress")!;
  const tapeProgress = Math.min(1, Math.max(0, recordingPosition / Math.max(recording.durationSeconds, 0.01)));
  progress.value = recordingPosition.toString();
  progress.style.setProperty("--progress", `${tapeProgress * 100}%`);
  document.querySelector("#history-elapsed")!.textContent = formatDuration(recordingPosition);
  const cassette = document.querySelector<HTMLElement>("#history-cassette")!;
  cassette.style.setProperty("--tape-progress", tapeProgress.toString());
  cassette.style.setProperty("--left-pack", (1 - tapeProgress * 0.48).toString());
  cassette.style.setProperty("--right-pack", (0.52 + tapeProgress * 0.48).toString());
  cassette.classList.toggle("playing", recordingPlaying);
  cassette.classList.toggle("tape-stopping", tapeStopping);
  document.querySelector("#history-transport-state")!.textContent = tapeStopping
    ? "TAPE STOP"
    : recordingPlaying
      ? "PLAYING"
      : recordingPosition > 0 && recordingPosition < recording.durationSeconds
        ? "PAUSED"
        : "STOPPED";
}

function updatePlaybackLevel(): void {
  if (!historyAnalyser || !historyLevelData || (!recordingPlaying && !tapeStopping)) {
    smoothedDb += (-60 - smoothedDb) * 0.2;
    updateDbMeter(smoothedDb);
    return;
  }
  historyAnalyser.getFloatTimeDomainData(historyLevelData);
  let energy = 0;
  for (let index = 0; index < historyLevelData.length; index += 1) energy += historyLevelData[index] * historyLevelData[index];
  const rms = Math.sqrt(energy / historyLevelData.length);
  const db = Math.max(-60, Math.min(0, 20 * Math.log10(Math.max(rms, 0.001))));
  smoothedDb += (db - smoothedDb) * (db > smoothedDb ? 0.36 : 0.12);
  updateDbMeter(smoothedDb);
}

function playbackTick(): void {
  if (!historyAudio) {
    playbackFrame = undefined;
    return;
  }
  recordingPosition = historyAudio.currentTime;
  updatePlaybackVisuals();
  updatePlaybackLevel();
  if (recordingPlaying || tapeStopping) playbackFrame = window.requestAnimationFrame(playbackTick);
  else playbackFrame = undefined;
}

function startPlaybackTicker(): void {
  if (playbackFrame !== undefined) window.cancelAnimationFrame(playbackFrame);
  playbackFrame = window.requestAnimationFrame(playbackTick);
}

function connectHistoryAnalyser(audio: HTMLAudioElement): void {
  try {
    historyAudioContext ??= new AudioContext();
    historyAudioSource?.disconnect();
    historyAudioSource = historyAudioContext.createMediaElementSource(audio);
    historyAnalyser = historyAudioContext.createAnalyser();
    historyAnalyser.fftSize = 1024;
    historyAnalyser.smoothingTimeConstant = 0.72;
    historyLevelData = new Float32Array(historyAnalyser.fftSize);
    historyAudioSource.connect(historyAnalyser);
    historyAnalyser.connect(historyAudioContext.destination);
  } catch {
    historyAudioSource = undefined;
    historyAnalyser = undefined;
    historyLevelData = undefined;
  }
}

function updateRecordingPlayer(): void {
  const recording = recordingHistory[selectedRecording];
  const progress = document.querySelector<HTMLInputElement>("#history-progress")!;
  const play = document.querySelector<HTMLButtonElement>("#history-play")!;
  const copy = document.querySelector<HTMLButtonElement>("#copy-transcript")!;
  const remove = document.querySelector<HTMLButtonElement>("#delete-recording")!;
  const removeAll = document.querySelector<HTMLButtonElement>("#delete-all-recordings")!;
  const rewind = document.querySelector<HTMLButtonElement>("#history-rewind")!;
  const forward = document.querySelector<HTMLButtonElement>("#history-forward")!;
  const mute = document.querySelector<HTMLButtonElement>("#history-mute")!;
  const cassette = document.querySelector<HTMLElement>("#history-cassette")!;
  const deckMeter = document.querySelector<HTMLElement>("#history-deck-meter")!;
  const settings = document.querySelector<HTMLButtonElement>("#history-recording-settings")!;
  document.querySelector("#history-count")!.textContent = recordingHistory.length.toString();
  removeAll.disabled = recordingHistory.length === 0;
  if (!recording) {
    cassette.hidden = true;
    deckMeter.hidden = true;
    settings.hidden = false;
    copy.hidden = true;
    remove.hidden = true;
    document.querySelector("#cassette-archive")!.textContent = "LOCAL ARCHIVE";
    document.querySelector("#cassette-title")!.textContent = "No recordings yet";
    document.querySelector("#cassette-code")!.textContent = "READY";
    const historyEnabled = (localStorage.getItem("indoor-voice:audio-retention") ?? "never") !== "never";
    document.querySelector("#history-transcript")!.textContent = historyEnabled
      ? "Your saved dictations will appear here."
      : "Recording history is off. Open Recording Settings to save audio and transcripts on this computer.";
    document.querySelector("#history-word-count")!.textContent = "0 words";
    document.querySelector("#history-total")!.textContent = "0:00";
    document.querySelector("#history-elapsed")!.textContent = "0:00";
    progress.value = "0";
    progress.max = "1";
    progress.disabled = true;
    play.disabled = true;
    rewind.disabled = true;
    forward.disabled = true;
    mute.disabled = true;
    copy.disabled = true;
    remove.disabled = true;
    document.querySelector("#history-transport-state")!.textContent = "STOPPED";
    updateDbMeter(-60);
    return;
  }
  const created = new Date(recording.createdAt);
  cassette.hidden = false;
  deckMeter.hidden = false;
  settings.hidden = true;
  copy.hidden = false;
  remove.hidden = false;
  document.querySelector("#cassette-archive")!.textContent = `ARCHIVE ${(selectedRecording + 1).toString().padStart(2, "0")}`;
  document.querySelector("#cassette-title")!.textContent = recording.title;
  document.querySelector("#cassette-code")!.textContent = created.toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "2-digit" }).replace(/\D/g, "");
  document.querySelector("#history-transcript")!.textContent = recording.transcript;
  document.querySelector("#history-word-count")!.textContent = `${recording.words} words`;
  document.querySelector("#history-total")!.textContent = formatDuration(recording.durationSeconds);
  document.querySelector("#history-elapsed")!.textContent = formatDuration(recordingPosition);
  progress.max = recording.durationSeconds.toString();
  progress.disabled = false;
  play.disabled = false;
  rewind.disabled = false;
  forward.disabled = false;
  mute.disabled = false;
  copy.disabled = false;
  remove.disabled = false;
  cassette.classList.toggle("rewinding", transportDirection === -1);
  cassette.classList.toggle("forwarding", transportDirection === 1);
  play.classList.toggle("paused", recordingPlaying);
  play.setAttribute("aria-label", recordingPlaying ? "Stop recording with tape slowdown" : tapeStopping ? "Resume recording" : "Play recording");
  updatePlaybackVisuals();
  document.querySelectorAll<HTMLElement>(".recording-row").forEach((row) => row.classList.toggle("active", Number(row.dataset.recording) === selectedRecording));
}

function cancelTapeStop(): void {
  if (tapeStopFrame !== undefined) window.cancelAnimationFrame(tapeStopFrame);
  tapeStopFrame = undefined;
  tapeStopping = false;
  if (historyAudio) historyAudio.playbackRate = 1;
}

function animateReelStop(): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  document.querySelectorAll<HTMLElement>("#history-cassette .cassette-reel i").forEach((reel, index) => {
    const current = getComputedStyle(reel).transform;
    reel.animate([{ transform: current }, { transform: `${current} rotate(${index === 0 ? 190 : 250}deg)` }], {
      duration: 460,
      easing: "cubic-bezier(.08,.72,.12,1)",
    });
  });
}

function pauseRecording(withTapeStop = false): void {
  recordingPlaying = false;
  if (withTapeStop && historyAudio && !historyAudio.paused && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    cancelTapeStop();
    tapeStopping = true;
    animateReelStop();
    const started = performance.now();
    const decelerate = (now: number): void => {
      if (!historyAudio || !tapeStopping) return;
      const progress = Math.min(1, (now - started) / 460);
      historyAudio.playbackRate = Math.max(0.25, 1 - progress * 0.75);
      if (progress < 1) {
        tapeStopFrame = window.requestAnimationFrame(decelerate);
        return;
      }
      historyAudio.pause();
      historyAudio.playbackRate = 1;
      tapeStopping = false;
      tapeStopFrame = undefined;
      updateRecordingPlayer();
      startPlaybackTicker();
    };
    tapeStopFrame = window.requestAnimationFrame(decelerate);
    startPlaybackTicker();
  } else {
    cancelTapeStop();
    historyAudio?.pause();
    updatePlaybackLevel();
  }
  updateRecordingPlayer();
}

async function selectRecording(index: number): Promise<void> {
  pauseRecording();
  selectedRecording = index;
  recordingPosition = 0;
  updateRecordingPlayer();
  const recording = recordingHistory[index];
  if (!recording) return;
  try {
    const source = await safeInvoke<string>("load_recording_audio", { id: recording.id });
    historyAudio = new Audio(source);
    historyAudio.preload = "auto";
    historyAudio.preservesPitch = false;
    (historyAudio as HTMLAudioElement & { webkitPreservesPitch?: boolean }).webkitPreservesPitch = false;
    connectHistoryAnalyser(historyAudio);
    historyAudio.onended = () => {
      recordingPlaying = false;
      tapeStopping = false;
      recordingPosition = recording.durationSeconds;
      updateRecordingPlayer();
      startPlaybackTicker();
    };
  } catch {
    historyAudio = undefined;
  }
}

async function toggleRecording(): Promise<void> {
  const recording = recordingHistory[selectedRecording];
  if (!recording) return;
  if (recordingPlaying) {
    pauseRecording(true);
    return;
  }
  cancelTapeStop();
  if (!historyAudio) await selectRecording(selectedRecording);
  if (!historyAudio) return;
  if (recordingPosition >= recording.durationSeconds) historyAudio.currentTime = 0;
  try {
    await historyAudioContext?.resume();
    await historyAudio.play();
  } catch {
    return;
  }
  recordingPlaying = true;
  updateRecordingPlayer();
  startPlaybackTicker();
}

function seekRecording(deltaSeconds: number): void {
  const recording = recordingHistory[selectedRecording];
  if (!recording) return;
  recordingPosition = Math.min(recording.durationSeconds, Math.max(0, recordingPosition + deltaSeconds));
  if (historyAudio) historyAudio.currentTime = recordingPosition;
  updateRecordingPlayer();
}

function stopTransport(skipOnTap: boolean): void {
  if (transportHoldTimer !== undefined) window.clearTimeout(transportHoldTimer);
  if (transportFrame !== undefined) window.cancelAnimationFrame(transportFrame);
  if (skipOnTap && !transportHeld && transportDirection !== 0) seekRecording(transportDirection * 5);
  transportHoldTimer = undefined;
  transportFrame = undefined;
  transportHeld = false;
  transportDirection = 0;
  updateRecordingPlayer();
}

function transportStep(now: number): void {
  if (!transportHeld || transportDirection === 0) return;
  const elapsed = Math.min(0.05, (now - transportLastFrame) / 1000);
  transportLastFrame = now;
  seekRecording(transportDirection * elapsed * 9);
  transportFrame = window.requestAnimationFrame(transportStep);
}

function startTransport(button: HTMLButtonElement, direction: -1 | 1, event: PointerEvent): void {
  if (!recordingHistory[selectedRecording]) return;
  event.preventDefault();
  button.setPointerCapture(event.pointerId);
  transportDirection = direction;
  transportHeld = false;
  updateRecordingPlayer();
  transportHoldTimer = window.setTimeout(() => {
    transportHeld = true;
    pauseRecording();
    transportDirection = direction;
    transportLastFrame = performance.now();
    transportFrame = window.requestAnimationFrame(transportStep);
  }, 230);
}

function bindTransportControl(selector: string, direction: -1 | 1): void {
  const button = document.querySelector<HTMLButtonElement>(selector)!;
  button.addEventListener("pointerdown", (event) => startTransport(button, direction, event));
  button.addEventListener("pointerup", () => stopTransport(true));
  button.addEventListener("pointercancel", () => stopTransport(false));
  button.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    transportDirection = direction;
    updateRecordingPlayer();
    seekRecording(direction * 5);
    window.setTimeout(() => {
      transportDirection = 0;
      updateRecordingPlayer();
    }, 180);
  });
}

function renderRecordingHistory(): void {
  const list = document.querySelector<HTMLDivElement>("#history-list")!;
  if (!recordingHistory.length) {
    const historyEnabled = (localStorage.getItem("indoor-voice:audio-retention") ?? "never") !== "never";
    list.innerHTML = historyEnabled
      ? `<div class="history-empty"><strong>No recordings yet</strong><span>Your saved dictations will appear here.</span></div>`
      : `<div class="history-empty"><strong>Recording history is off</strong><span>Turn it on in Privacy to keep audio and transcripts.</span></div>`;
    updateRecordingPlayer();
    return;
  }
  const query = document.querySelector<HTMLInputElement>("#history-search")?.value.trim().toLocaleLowerCase() ?? "";
  const visibleRecordings = recordingHistory
    .map((recording, index) => ({ recording, index }))
    .filter(({ recording }) => !query || `${recording.title}\n${recording.transcript}`.toLocaleLowerCase().includes(query));
  if (!visibleRecordings.length) {
    list.innerHTML = `<div class="history-empty"><strong>No matching recordings</strong><span>Try a different word or phrase.</span></div>`;
    updateRecordingPlayer();
    return;
  }
  list.innerHTML = visibleRecordings
    .map(
      ({ recording, index }) => `<div class="recording-row${index === selectedRecording ? " active" : ""}" data-recording="${index}">
        <button class="recording-select" type="button" aria-label="Open ${escapeHtml(recording.title)}"><span class="mini-cassette"><i></i><i></i></span><span><strong>${escapeHtml(recording.title)}</strong><small>${escapeHtml(new Date(recording.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</small></span><time>${formatDuration(recording.durationSeconds)}</time></button>
        <button class="recording-delete" type="button" aria-label="Delete ${escapeHtml(recording.title)}" title="Delete recording">×</button>
      </div>`,
    )
    .join("");
  list.querySelectorAll<HTMLElement>(".recording-row").forEach((row) => {
    const index = Number(row.dataset.recording);
    row.querySelector<HTMLButtonElement>(".recording-select")!.addEventListener("click", () => selectRecording(index));
    row.querySelector<HTMLButtonElement>(".recording-delete")!.addEventListener("click", () => requestRecordingDelete(index));
  });
  updateRecordingPlayer();
}

function requestRecordingDelete(index: number | "all"): void {
  if (index === "all") {
    if (!recordingHistory.length) return;
    pendingRecordingDelete = "all";
    document.querySelector("#delete-recording-title")!.textContent = `Delete all ${recordingHistory.length} recordings?`;
    deleteRecordingCopy.textContent = "Every saved audio file and transcript will be permanently removed from this computer.";
  } else {
    const recording = recordingHistory[index];
    if (!recording) return;
    pendingRecordingDelete = index;
    document.querySelector("#delete-recording-title")!.textContent = `Delete “${recording.title}”?`;
    deleteRecordingCopy.textContent = "This permanently removes its audio and transcript from this computer.";
  }
  deleteRecordingError.textContent = "";
  deleteRecordingDialog.returnValue = "";
  deleteRecordingDialog.showModal();
}

async function deleteRecordingAt(index: number): Promise<void> {
  const recording = recordingHistory[index];
  if (!recording) return;
  pauseRecording();
  await safeInvoke("delete_recording", { id: recording.id });
  selectedRecording = Math.min(index, Math.max(0, recordingHistory.length - 2));
  await loadRecordingHistory();
}

async function deleteAllRecordings(): Promise<void> {
  if (!recordingHistory.length) return;
  pauseRecording();
  const ids = recordingHistory.map((recording) => recording.id);
  for (const id of ids) await safeInvoke("delete_recording", { id });
  selectedRecording = 0;
  await loadRecordingHistory();
}

async function confirmRecordingDelete(): Promise<void> {
  if (pendingRecordingDelete === undefined) return;
  const button = document.querySelector<HTMLButtonElement>("#confirm-delete-recording")!;
  const actionStatus = document.querySelector<HTMLParagraphElement>("#history-action-status")!;
  button.disabled = true;
  button.textContent = "Deleting…";
  deleteRecordingError.textContent = "";
  try {
    if (pendingRecordingDelete === "all") await deleteAllRecordings();
    else await deleteRecordingAt(pendingRecordingDelete);
    actionStatus.textContent = pendingRecordingDelete === "all" ? "All recordings deleted." : "Recording deleted.";
    pendingRecordingDelete = undefined;
    deleteRecordingDialog.close("deleted");
  } catch (error) {
    deleteRecordingError.textContent = error instanceof Error ? error.message : "The recording could not be deleted.";
  } finally {
    button.disabled = false;
    button.textContent = "Delete permanently";
  }
}

async function loadRecordingHistory(): Promise<void> {
  try {
    recordingHistory = await safeInvoke<RecordingEntry[]>("list_recordings");
    const retention = localStorage.getItem("indoor-voice:audio-retention") ?? "never";
    const maximumAge = retention === "day" ? 86_400_000 : retention === "week" ? 604_800_000 : 0;
    if (maximumAge) {
      const expired = recordingHistory.filter((recording) => Date.now() - recording.createdAt > maximumAge);
      for (const recording of expired) await safeInvoke("delete_recording", { id: recording.id });
      if (expired.length) recordingHistory = await safeInvoke<RecordingEntry[]>("list_recordings");
    }
  } catch {
    recordingHistory = [];
  }
  selectedRecording = Math.min(selectedRecording, Math.max(0, recordingHistory.length - 1));
  renderRecordingHistory();
  if (recordingHistory.length) await selectRecording(selectedRecording);
}

const pillPositionNames: Record<PillPosition, string> = {
  "top-left": "Top left",
  "top-center": "Top center",
  "top-right": "Top right",
  "center-left": "Center left",
  center: "Screen center",
  "center-right": "Center right",
  "bottom-left": "Bottom left",
  "bottom-center": "Bottom center",
  "bottom-right": "Bottom right",
};

const pillStateNames: Record<CustomizablePillState, string> = {
  idle: "Ready",
  listening: "Listening",
  working: "Processing",
  success: "Inserted",
  error: "Error",
};

const pillStateDescriptions: Record<CustomizablePillState, string> = {
  idle: "Customize the compact pill that waits on screen.",
  listening: "Customize what appears while your microphone is active.",
  working: "Customize the moment Whisper is turning audio into text.",
  success: "Customize the confirmation shown after text is inserted.",
  error: "Customize the recovery message when dictation cannot finish.",
};

function renderAppearancePreview(): void {
  const preview = document.querySelector<HTMLElement>("#appearance-pill")!;
  const previewContent = preview.querySelector<HTMLElement>(".pill-content")!;
  const previewCluster = document.querySelector<HTMLElement>("#appearance-pill-cluster")!;
  const previewCancel = document.querySelector<HTMLButtonElement>("#appearance-pill-cancel")!;
  const previousRect = beginPillGeometryTransition(preview);
  const previousContentMode = preview.dataset.contentMode;
  const morphsFromSpinner = previousAppearancePreviewState === "working"
    && appearancePreviewState === "success"
    && stateCustomization(pillCustomization, "working").contentMode === "waveform";
  const previewStage = stateCustomization(pillCustomization, appearancePreviewState);
  const keepsLivingWave = !usesExpandedListening(appearancePreviewState) && previousContentMode === "waveform"
    && previewStage.contentMode === "waveform"
    && previewContent.querySelector(".brand-waveform") !== null
    && (previousAppearancePreviewState === "listening" || previousAppearancePreviewState === "handsfree" || previousAppearancePreviewState === "working")
    && (appearancePreviewState === "listening" || appearancePreviewState === "handsfree" || appearancePreviewState === "working");
  const previewMessage = previewStage.contentMode === "transcript" && appearancePreviewState === "listening"
    ? "This is live text as you speak…"
    : appearancePreviewState === "error"
      ? "Microphone unavailable"
      : appearancePreviewState === "success" && previewStage.contentMode === "transcript"
        ? "Meet at 15:00 tomorrow."
        : undefined;
  transitionPillContent({
    pill: preview,
    content: previewContent,
    markup: pillMarkup(appearancePreviewState, previewMessage),
    fromState: previousAppearancePreviewState,
    toState: appearancePreviewState,
    reuseContent: keepsLivingWave,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  });
  const expandedClass = usesExpandedListening(appearancePreviewState) ? " expanded-listening" : "";
  previewCluster.className = `pill-cluster appearance-pill-cluster ${appearancePreviewState}${expandedClass}${morphsFromSpinner ? " spinner-to-success" : ""}`;
  preview.className = `voice-pill appearance-pill ${appearancePreviewState}${expandedClass}${morphsFromSpinner ? " spinner-to-success" : ""}`;
  applyPillCustomization(previewCluster, pillCustomization, appearancePreviewState);
  applyPillCustomization(preview, pillCustomization, appearancePreviewState);
  preview.dataset.contentMode = previewStage.contentMode;
  setWaveformMode(preview, previewStage.contentMode !== "waveform"
    ? "idle"
    : appearancePreviewState === "working" ? "thinking"
      : appearancePreviewState === "listening" ? "listening" : "idle");
  previewCancel.disabled = appearancePreviewState !== "working";
  previewCancel.setAttribute("aria-hidden", String(appearancePreviewState !== "working"));
  finishPillGeometryTransition(preview, previousRect);
  document.querySelector("#appearance-state-label")!.textContent = pillStateLabel(appearancePreviewState);
  document.querySelectorAll<HTMLButtonElement>("[data-preview-state]").forEach((button) => {
    button.classList.toggle("active", button.dataset.previewState === appearancePreviewState);
  });
  previousAppearancePreviewState = appearancePreviewState;
}

function colorLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(first: string, second: string): number {
  const high = Math.max(colorLuminance(first), colorLuminance(second));
  const low = Math.min(colorLuminance(first), colorLuminance(second));
  return (high + 0.05) / (low + 0.05);
}

function appearanceContrastIsValid(): boolean {
  return (Object.keys(pillCustomization.states) as CustomizablePillState[]).every((state) => {
    const stage = pillCustomization.states[state];
    return contrastRatio(stage.text, stage.background) >= 4.5
      && contrastRatio(stage.accent, stage.background) >= 3;
  });
}

function syncRangeFill(input: HTMLInputElement): void {
  const minimum = Number(input.min || 0);
  const maximum = Number(input.max || 100);
  const value = Number(input.value);
  const percent = maximum === minimum ? 0 : ((value - minimum) / (maximum - minimum)) * 100;
  input.style.setProperty("--range-progress", `${percent}%`);
}

function syncAppearanceControls(): void {
  const selectedStage = pillCustomization.states[selectedCustomizationState];
  document.querySelector<HTMLInputElement>("#pill-margin")!.value = String(pillCustomization.margin);
  document.querySelector<HTMLInputElement>("#pill-scale")!.value = String(Math.round(pillCustomization.scale * 100));
  document.querySelector<HTMLInputElement>("#pill-opacity")!.value = String(selectedStage.backgroundOpacity);
  document.querySelector<HTMLInputElement>("#pill-shadow")!.value = String(selectedStage.shadow);
  document.querySelector("#pill-margin-value")!.textContent = `${pillCustomization.margin}px`;
  document.querySelector("#pill-scale-value")!.textContent = `${Math.round(pillCustomization.scale * 100)}%`;
  document.querySelector("#pill-opacity-value")!.textContent = `${selectedStage.backgroundOpacity}%`;
  document.querySelector("#pill-shadow-value")!.textContent = `${selectedStage.shadow}%`;
  document.querySelector("#pill-position-label")!.textContent = pillPositionNames[pillCustomization.position];
  document.querySelectorAll<HTMLButtonElement>("[data-pill-scale]").forEach((button) => {
    const scale = Number(button.dataset.pillScale);
    const selected = Math.abs(pillCustomization.scale - scale) < 0.015;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-listening-layout]").forEach((button) => {
    const selected = button.dataset.listeningLayout === pillCustomization.listeningLayout;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-checked", String(selected));
  });
  document.querySelector("#state-editor-title")!.textContent = pillStateNames[selectedCustomizationState];
  document.querySelector("#state-editor-description")!.textContent = pillStateDescriptions[selectedCustomizationState];
  document.querySelector(".content-status")!.textContent = `${pillStateNames[selectedCustomizationState]}…`;
  document.querySelector(".content-transcript")!.textContent = {
    idle: "Ready",
    listening: "Live text…",
    working: "Processing speech…",
    success: "Meet at 15:00",
    error: "Try again",
  }[selectedCustomizationState];
  document.querySelectorAll<HTMLButtonElement>("[data-pill-content]").forEach((button) => {
    button.classList.toggle("active", button.dataset.pillContent === selectedStage.contentMode);
  });
  document.querySelector("#pill-content-help")!.textContent = {
    waveform: selectedCustomizationState === "listening"
      ? "Layered waves cross, separate, brighten, and move with your microphone level."
      : selectedCustomizationState === "working"
        ? "The wave distills into five clear thinking rings that rotate independently in alternating directions."
        : selectedCustomizationState === "success"
          ? "The processing circle becomes the green completion check; confirmation text opens to its right."
          : "Uses the compact living-wave symbol for this moment.",
    levels: selectedCustomizationState === "listening" ? "The classic vertical bars respond to microphone level in real time." : "A compact animated symbol communicates this moment.",
    status: `Shows a short “${pillStateNames[selectedCustomizationState]}” label.`,
    transcript: selectedCustomizationState === "listening"
      ? "Shows a live local Whisper preview while you speak; the final transcript replaces it on release."
      : selectedCustomizationState === "success"
        ? "Shows the finished text after Whisper completes."
        : "Shows the text available for this moment.",
  }[selectedStage.contentMode];
  document.querySelector<HTMLInputElement>("#pill-state-indicator")!.checked = selectedStage.showIndicator;
  const indicatorToggle = document.querySelector<HTMLElement>(".state-indicator-toggle")!;
  indicatorToggle.querySelector("strong")!.textContent = selectedCustomizationState === "success"
    ? "Completion check"
    : selectedCustomizationState === "error"
      ? "Error marker"
      : "Processing indicator";
  indicatorToggle.querySelector("small")!.textContent = selectedCustomizationState === "success"
    ? "Turn the processing circle green and reveal its checkmark."
    : selectedCustomizationState === "error"
      ? "Show the colored warning marker beside the recovery text."
      : "Show the compact progress mark while Whisper works.";
  indicatorToggle.hidden = !(
    selectedCustomizationState === "success"
    || selectedCustomizationState === "error"
    || (selectedCustomizationState === "working" && selectedStage.contentMode !== "waveform")
  );
  const waveEffectEditor = document.querySelector<HTMLElement>("#wave-effect-editor")!;
  waveEffectEditor.hidden = selectedStage.contentMode !== "waveform";
  applyWaveformEffect(document.querySelector<HTMLElement>(".content-waveform")!, pillCustomization.waveformEffect);
  document.querySelectorAll<HTMLInputElement>("[data-wave-color]").forEach((input) => {
    const key = input.dataset.waveColor as "startColor" | "middleColor" | "endColor";
    input.value = pillCustomization.waveformEffect[key];
    const output = document.querySelector<HTMLOutputElement>(`[data-wave-color-value="${key}"]`);
    if (output) output.textContent = input.value.toUpperCase();
  });
  document.querySelector<HTMLSelectElement>("#wave-line-count")!.value = String(pillCustomization.waveformEffect.lineCount);
  document.querySelectorAll<HTMLInputElement>("[data-wave-effect]").forEach((input) => {
    const key = input.dataset.waveEffect as "thickness" | "separation" | "reactivity" | "speed";
    const percent = Math.round(pillCustomization.waveformEffect[key] * 100);
    input.value = String(percent);
    const output = document.querySelector<HTMLOutputElement>(`[data-wave-effect-value="${key}"]`);
    if (output) output.textContent = `${percent}%`;
    syncRangeFill(input);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-pill-position]").forEach((button) => {
    button.classList.toggle("active", button.dataset.pillPosition === pillCustomization.position);
  });
  document.querySelectorAll<HTMLInputElement>("[data-state-color]").forEach((input) => {
    const key = input.dataset.stateColor as "background" | "text" | "accent";
    input.value = selectedStage[key];
    const output = document.querySelector<HTMLOutputElement>(`[data-state-color-value="${key}"]`);
    if (output) output.textContent = selectedStage[key].toUpperCase();
  });
  ["#pill-margin", "#pill-scale", "#pill-opacity", "#pill-shadow"].forEach((selector) => syncRangeFill(document.querySelector<HTMLInputElement>(selector)!));
  document.querySelectorAll<HTMLButtonElement>("[data-appearance-preset]").forEach((button) => {
    const selected = button.dataset.appearancePreset === appearancePreset;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-checked", String(selected));
  });
  const contrastStatus = document.querySelector<HTMLElement>("#appearance-contrast-status")!;
  const validContrast = appearanceContrastIsValid();
  contrastStatus.textContent = validContrast
    ? "Every pill moment passes the text and accent contrast check."
    : "One or more moments need stronger contrast before they can be saved.";
  contrastStatus.classList.toggle("error", !validContrast);
  document.querySelector("#appearance-contrast-icon")!.textContent = validContrast ? "✓" : "!";
  document.querySelector(".appearance-accessibility")!.classList.toggle("error", !validContrast);
  renderAppearancePreview();
}

function palettePreset(background: string, text: string, accents: Record<CustomizablePillState, string>, opacity?: number): typeof DEFAULT_PILL_CUSTOMIZATION {
  const preset = normalizePillCustomization(DEFAULT_PILL_CUSTOMIZATION);
  (Object.keys(preset.states) as CustomizablePillState[]).forEach((state) => {
    preset.states[state] = {
      ...preset.states[state],
      background,
      text,
      accent: accents[state],
      backgroundOpacity: opacity ?? preset.states[state].backgroundOpacity,
    };
  });
  preset.background = background;
  preset.text = text;
  return preset;
}

const appearancePresets: Record<Exclude<AppearancePreset, "custom">, typeof DEFAULT_PILL_CUSTOMIZATION> = {
  system: normalizePillCustomization(DEFAULT_PILL_CUSTOMIZATION),
  graphite: palettePreset("#20211f", "#f7f8f5", { idle: "#a7aaa4", listening: "#55e77d", working: "#f7f8f5", success: "#38c768", error: "#ef5d58" }),
  contrast: palettePreset("#000000", "#ffffff", { idle: "#ffffff", listening: "#6cff8f", working: "#ffffff", success: "#6cff8f", error: "#ff6b66" }, 100),
};

function markAppearanceCustom(): void {
  appearancePreset = "custom";
  localStorage.setItem("indoor-voice:appearance-preset", appearancePreset);
}

function applyCurrentPillCustomization(persist = true): void {
  pillCustomization = normalizePillCustomization(pillCustomization);
  const validContrast = appearanceContrastIsValid();
  if (persist && validContrast) savePillCustomization(pillCustomization);
  applyPillCustomization(pillCluster, pillCustomization, currentPillState);
  applyPillCustomization(pill, pillCustomization, currentPillState);
  const previousContentMode = pill.dataset.contentMode;
  const currentStage = stateCustomization(pillCustomization, currentPillState);
  const expandedClass = usesExpandedListening(currentPillState) ? " expanded-listening" : "";
  pillCluster.className = `pill-cluster home-pill-cluster ${currentPillState}${expandedClass}`;
  pill.className = `voice-pill ${currentPillState}${expandedClass}${capturePaused ? " capture-paused" : ""}`;
  pill.dataset.contentMode = currentStage.contentMode;
  transitionPillContent({
    pill,
    content: pillContent,
    markup: pillMarkup(currentPillState, currentPillMessage),
    fromState: currentPillState,
    toState: currentPillState,
    reuseContent: !usesExpandedListening(currentPillState) && previousContentMode === "waveform"
      && currentStage.contentMode === "waveform"
      && pillContent.querySelector(".brand-waveform") !== null,
    reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  });
  setWaveformMode(pill, pill.dataset.contentMode !== "waveform"
    ? "idle"
    : currentPillState === "working" ? "thinking"
      : currentPillState === "listening" || currentPillState === "handsfree" ? "listening" : "idle");
  renderAppearancePreview();
  void emit("pill-customization", pillCustomization).catch(() => {
    // Browser preview has no native event bus.
  });
  void safeInvoke("set_pill_position", {
    position: pillCustomization.position,
    margin: pillCustomization.margin,
  }).catch(() => {
    // Browser preview has no native pill window.
  });
  const status = document.querySelector("#appearance-status");
  if (status) status.textContent = validContrast
    ? "Saved on this computer · floating pill updated"
    : "Not saved · adjust the colors until the contrast check passes";
}

document.querySelectorAll<HTMLButtonElement>("[data-preview-state]").forEach((button) => {
  button.addEventListener("click", () => {
    appearancePreviewState = button.dataset.previewState as CustomizablePillState;
    selectedCustomizationState = appearancePreviewState;
    syncAppearanceControls();
  });
});
document.querySelectorAll<HTMLButtonElement>("[data-pill-position]").forEach((button) => {
  button.addEventListener("click", () => {
    markAppearanceCustom();
    pillCustomization.position = button.dataset.pillPosition as PillPosition;
    syncAppearanceControls();
    applyCurrentPillCustomization();
  });
});
document.querySelectorAll<HTMLInputElement>("[data-state-color]").forEach((input) => {
  input.addEventListener("input", () => {
    markAppearanceCustom();
    const key = input.dataset.stateColor as "background" | "text" | "accent";
    pillCustomization.states[selectedCustomizationState][key] = input.value;
    syncAppearanceControls();
    applyCurrentPillCustomization();
  });
});
document.querySelectorAll<HTMLInputElement>("[data-wave-color]").forEach((input) => {
  input.addEventListener("input", () => {
    markAppearanceCustom();
    const key = input.dataset.waveColor as "startColor" | "middleColor" | "endColor";
    pillCustomization.waveformEffect[key] = input.value;
    syncAppearanceControls();
    applyCurrentPillCustomization();
  });
});
document.querySelector<HTMLSelectElement>("#wave-line-count")!.addEventListener("change", (event) => {
  markAppearanceCustom();
  pillCustomization.waveformEffect.lineCount = Number((event.target as HTMLSelectElement).value);
  syncAppearanceControls();
  applyCurrentPillCustomization();
});
document.querySelectorAll<HTMLInputElement>("[data-wave-effect]").forEach((input) => {
  input.addEventListener("input", () => {
    markAppearanceCustom();
    const key = input.dataset.waveEffect as "thickness" | "separation" | "reactivity" | "speed";
    pillCustomization.waveformEffect[key] = Number(input.value) / 100;
    syncAppearanceControls();
    applyCurrentPillCustomization();
  });
});
document.querySelectorAll<HTMLButtonElement>("[data-pill-content]").forEach((button) => {
  button.addEventListener("click", () => {
    markAppearanceCustom();
    pillCustomization.states[selectedCustomizationState].contentMode = button.dataset.pillContent as PillContentMode;
    syncAppearanceControls();
    applyCurrentPillCustomization();
  });
});
document.querySelector<HTMLInputElement>("#pill-state-indicator")!.addEventListener("change", (event) => {
  markAppearanceCustom();
  pillCustomization.states[selectedCustomizationState].showIndicator = (event.target as HTMLInputElement).checked;
  syncAppearanceControls();
  applyCurrentPillCustomization();
});
document.querySelector<HTMLInputElement>("#pill-margin")!.addEventListener("input", (event) => {
  markAppearanceCustom();
  pillCustomization.margin = Number((event.target as HTMLInputElement).value);
  syncAppearanceControls();
  applyCurrentPillCustomization();
});
document.querySelector<HTMLInputElement>("#pill-scale")!.addEventListener("input", (event) => {
  markAppearanceCustom();
  pillCustomization.scale = Number((event.target as HTMLInputElement).value) / 100;
  syncAppearanceControls();
  applyCurrentPillCustomization();
});
document.querySelectorAll<HTMLButtonElement>("[data-pill-scale]").forEach((button) => {
  button.addEventListener("click", () => {
    markAppearanceCustom();
    pillCustomization.scale = Number(button.dataset.pillScale);
    syncAppearanceControls();
    applyCurrentPillCustomization();
  });
});
document.querySelectorAll<HTMLButtonElement>("[data-listening-layout]").forEach((button) => {
  button.addEventListener("click", () => {
    markAppearanceCustom();
    pillCustomization.listeningLayout = button.dataset.listeningLayout === "expanded" ? "expanded" : "compact";
    appearancePreviewState = "listening";
    selectedCustomizationState = "listening";
    syncAppearanceControls();
    applyCurrentPillCustomization();
  });
});
document.querySelector<HTMLInputElement>("#pill-opacity")!.addEventListener("input", (event) => {
  markAppearanceCustom();
  pillCustomization.states[selectedCustomizationState].backgroundOpacity = Number((event.target as HTMLInputElement).value);
  syncAppearanceControls();
  applyCurrentPillCustomization();
});
document.querySelector<HTMLInputElement>("#pill-shadow")!.addEventListener("input", (event) => {
  markAppearanceCustom();
  pillCustomization.states[selectedCustomizationState].shadow = Number((event.target as HTMLInputElement).value);
  syncAppearanceControls();
  applyCurrentPillCustomization();
});
document.querySelector("#reset-appearance")!.addEventListener("click", () => {
  appearancePreset = "system";
  localStorage.setItem("indoor-voice:appearance-preset", appearancePreset);
  pillCustomization = normalizePillCustomization(DEFAULT_PILL_CUSTOMIZATION);
  selectedCustomizationState = "listening";
  appearancePreviewState = "listening";
  syncAppearanceControls();
  applyCurrentPillCustomization();
});
document.querySelectorAll<HTMLButtonElement>("[data-appearance-preset]").forEach((button) => {
  button.addEventListener("click", () => {
    const preset = button.dataset.appearancePreset as AppearancePreset;
    if (preset === "custom") {
      appearancePreset = "custom";
      localStorage.setItem("indoor-voice:appearance-preset", appearancePreset);
      syncAppearanceControls();
      return;
    }
    appearancePreset = preset;
    localStorage.setItem("indoor-voice:appearance-preset", appearancePreset);
    pillCustomization = normalizePillCustomization(appearancePresets[preset]);
    syncAppearanceControls();
    applyCurrentPillCustomization();
  });
});

function activatePage(pageName: string): void {
  document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((item) => {
    const active = item.dataset.page === pageName;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  document.querySelectorAll(".page").forEach((page) => page.classList.toggle("active", page.id === `page-${pageName}`));
  if (pageName === "providers") void renderProviders();
  if (pageName === "appearance") syncAppearanceControls();
  if (pageName === "stats" || pageName === "home") renderStatistics();
  if (pageName !== "history") pauseRecording();
  document.querySelector(".main")?.scrollTo({ top: 0, behavior: "smooth" });
}

document.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((button) => {
  button.addEventListener("click", () => activatePage(button.dataset.page!));
});
document.querySelectorAll<HTMLButtonElement>("[data-page-link]").forEach((button) => {
  button.addEventListener("click", () => activatePage(button.dataset.pageLink!));
});

document.querySelectorAll<HTMLButtonElement>(".shortcut-change").forEach((button) => {
  button.addEventListener("click", beginShortcutCapture);
});
document.querySelectorAll<HTMLButtonElement>("[data-shortcut-preset]").forEach((button) => {
  button.addEventListener("click", () => void commitShortcut(button.dataset.shortcutPreset!));
});
shortcutDialog.addEventListener("close", () => {
  if (!shortcutCapturing) return;
  finishShortcutCapture(false);
  setShortcutStatus("Shortcut change cancelled. Your previous shortcut is still active.");
});
deleteRecordingDialog.addEventListener("close", () => {
  if (deleteRecordingDialog.returnValue !== "deleted") pendingRecordingDelete = undefined;
});
document.querySelector("#confirm-delete-recording")!.addEventListener("click", () => void confirmRecordingDelete());
window.addEventListener("blur", () => {
  if (!shortcutCapturing) return;
  finishShortcutCapture();
  setShortcutStatus("Shortcut editor closed. Your active shortcut still works everywhere.");
});
window.addEventListener("focus", () => void refreshAccessibilityStatus());

document.querySelector("#history-play")!.addEventListener("click", () => void toggleRecording());
bindTransportControl("#history-rewind", -1);
bindTransportControl("#history-forward", 1);
document.querySelector<HTMLInputElement>("#history-progress")!.addEventListener("input", (event) => {
  recordingPosition = Number((event.target as HTMLInputElement).value);
  if (historyAudio) historyAudio.currentTime = recordingPosition;
  updateRecordingPlayer();
});
document.querySelector("#history-mute")!.addEventListener("click", (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  button.classList.toggle("muted");
  if (historyAudio) historyAudio.muted = button.classList.contains("muted");
  button.textContent = button.classList.contains("muted") ? "×" : "◖";
  button.setAttribute("aria-label", button.classList.contains("muted") ? "Unmute recording" : "Mute recording");
});
document.querySelector("#copy-transcript")!.addEventListener("click", async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const recording = recordingHistory[selectedRecording];
  if (!recording) return;
  try {
    await navigator.clipboard.writeText(recording.transcript);
    button.textContent = "Transcript Copied";
  } catch {
    button.textContent = "Copy unavailable";
  }
  window.setTimeout(() => (button.textContent = "Copy Transcript"), 1200);
});
document.querySelector("#delete-recording")!.addEventListener("click", () => requestRecordingDelete(selectedRecording));
document.querySelector("#delete-all-recordings")!.addEventListener("click", () => requestRecordingDelete("all"));
document.querySelector<HTMLInputElement>("#history-search")!.addEventListener("input", renderRecordingHistory);

const testDictationButton = document.querySelector<HTMLButtonElement>("#try-pill")!;
testDictationButton.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  testDictationButton.setPointerCapture(event.pointerId);
  void startMicrophoneCapture("ptt");
});
const stopTestDictation = (): void => {
  if (captureStarting) releaseRequested = true;
  else void finishMicrophoneCapture(false);
};
testDictationButton.addEventListener("pointerup", stopTestDictation);
testDictationButton.addEventListener("pointercancel", stopTestDictation);
document.querySelector("#download-model")!.addEventListener("click", () => void downloadLocalModel());
document.querySelector("#enable-microphone")!.addEventListener("click", () => void requestMicrophonePermission());
document.querySelector("#enable-accessibility")!.addEventListener("click", () => void openAccessibilitySettings());
document.querySelector("#reset-pill")!.addEventListener("click", () => {
  insertedText.textContent = "";
  demoMessage.textContent = "Download the local model, then hold this button or ⌥ Space to dictate.";
  setPillState("idle");
});
document.querySelector<HTMLButtonElement>("#undo-insertion")!.addEventListener("click", async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  try {
    await safeInvoke("undo_last_insertion");
    button.disabled = true;
    demoMessage.textContent = "Last insertion undone in the focused app.";
  } catch (error) {
    demoMessage.textContent = error instanceof Error ? error.message : "The last insertion could not be undone.";
  }
});
pillCancel.addEventListener("click", () => void cancelProcessing());
pill.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("[data-capture-pause]")) void setCapturePaused(!capturePaused);
  if (target.closest("[data-capture-cancel]")) void cancelMicrophoneCapture();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && processingActive) void cancelProcessing();
});

document.querySelector("#provider-form")!.addEventListener("submit", async (event) => {
  event.preventDefault();
  const provider = providerIdInput.value as ProviderId;
  providerError.textContent = "";
  try {
    if (provider === "local") {
      await safeInvoke("validate_local_endpoint", { baseUrl: providerUrlInput.value.trim() });
      localStorage.setItem("indoor-voice:local-url", providerUrlInput.value.trim());
      localStorage.setItem("indoor-voice:local-model", providerModelInput.value.trim());
    } else {
      if (!providerKeyInput.value.trim()) throw new Error("Paste a key before saving.");
      if (provider === "bedrock") {
        await safeInvoke("validate_bedrock_region", { region: providerRegionInput.value.trim() });
      }
      await safeInvoke("save_provider_key", { provider, secret: providerKeyInput.value });
      localStorage.setItem(`indoor-voice:key-configured:${provider}`, "true");
      localStorage.setItem(`indoor-voice:model:${provider}`, providerModelInput.value.trim());
      if (provider === "bedrock") {
        localStorage.setItem("indoor-voice:bedrock-region", providerRegionInput.value.trim());
      }
    }
    providerKeyInput.value = "";
    providerDialog.close();
    await renderProviders();
    syncActiveModelEditor();
  } catch (error) {
    providerKeyInput.value = "";
    providerError.textContent = error instanceof Error ? error.message : "Could not save this provider.";
  }
});

providerDialog.addEventListener("close", () => {
  providerKeyInput.value = "";
  providerError.textContent = "";
});

const activeCleanupSelect = document.querySelector<HTMLSelectElement>("#active-cleanup")!;
const activeModelInput = document.querySelector<HTMLInputElement>("#active-model")!;
const activeModelHelp = document.querySelector<HTMLElement>("#active-model-help")!;
const cleanupPromptInput = document.querySelector<HTMLTextAreaElement>("#cleanup-prompt")!;
const promptCount = document.querySelector<HTMLElement>("#prompt-count")!;
const aiBehaviorStatus = document.querySelector<HTMLElement>("#ai-behavior-status")!;
const listStyleSelect = document.querySelector<HTMLSelectElement>("#list-style")!;
activeCleanupSelect.value = localStorage.getItem("indoor-voice:cleanup-provider") ?? "off";
cleanupPromptInput.value = loadCleanupPrompt();
listStyleSelect.value = selectedListStyle() ?? DEFAULT_LIST_STYLE;
listStyleSelect.addEventListener("change", () => {
  localStorage.setItem(LIST_STYLE_KEY, normalizeListStyle(listStyleSelect.value));
});

function updatePromptCount(): void {
  promptCount.textContent = `${cleanupPromptInput.value.length.toLocaleString()} / 12,000`;
}

function syncActiveModelEditor(): void {
  const selected = activeCleanupSelect.value;
  const definition = providers.find((provider) => provider.id === selected);
  activeModelInput.disabled = !definition;
  activeModelInput.value = definition
    ? localStorage.getItem(`indoor-voice:model:${selected}`) ?? definition.defaultModel
    : "";
  activeModelHelp.textContent = definition
    ? `${definition.name} model identifier · editable`
    : "Choose a cleanup provider first.";
}

function updateCleanupRouteLabel(): void {
  const selected = activeCleanupSelect.value;
  const definition = providers.find((provider) => provider.id === selected);
  document.querySelector("#cleanup-route")!.textContent = definition
    ? `${definition.name} · transcript text only`
    : "Off · original transcript is preserved";
  document.querySelector("#cleanup-privacy-route")!.textContent = definition
    ? definition.local
      ? "Transcript text stays on this computer."
      : `Transcript text is sent to ${definition.name}. Audio is never sent.`
    : "Off keeps the original transcript on this computer.";
}
activeCleanupSelect.addEventListener("change", () => {
  localStorage.setItem("indoor-voice:cleanup-provider", activeCleanupSelect.value);
  updateCleanupRouteLabel();
  syncActiveModelEditor();
  aiBehaviorStatus.textContent = activeCleanupSelect.value === "off" ? "Text Cleanup is off." : "Cleanup provider selected. Save any advanced changes below.";
});
updateCleanupRouteLabel();
syncActiveModelEditor();
updatePromptCount();
cleanupPromptInput.addEventListener("input", updatePromptCount);
document.querySelector("#reset-cleanup-prompt")!.addEventListener("click", () => {
  cleanupPromptInput.value = DEFAULT_CLEANUP_PROMPT;
  updatePromptCount();
  aiBehaviorStatus.textContent = "Default instructions restored. Save to apply them.";
});
document.querySelector("#save-ai-behavior")!.addEventListener("click", () => {
  const prompt = cleanupPromptInput.value.trim();
  if (prompt.length < 20) {
    aiBehaviorStatus.textContent = "Write at least 20 characters of cleanup instructions.";
    cleanupPromptInput.focus();
    return;
  }
  localStorage.setItem(CLEANUP_PROMPT_KEY, prompt);
  const provider = activeCleanupSelect.value;
  const definition = providers.find((item) => item.id === provider);
  if (definition) {
    const model = activeModelInput.value.trim();
    if (!model) {
      aiBehaviorStatus.textContent = "Enter a model identifier before saving.";
      activeModelInput.focus();
      return;
    }
    localStorage.setItem(`indoor-voice:model:${provider}`, model);
    const previewProvider = document.querySelector<HTMLSelectElement>("#preview-provider")!;
    if (previewProvider.value === provider) document.querySelector<HTMLInputElement>("#preview-model")!.value = model;
  }
  aiBehaviorStatus.textContent = "Cleanup settings saved";
});

const audioRetentionSelect = document.querySelector<HTMLSelectElement>("#audio-retention")!;
audioRetentionSelect.value = localStorage.getItem("indoor-voice:audio-retention") ?? "never";
audioRetentionSelect.addEventListener("change", () => {
  localStorage.setItem("indoor-voice:audio-retention", audioRetentionSelect.value);
  void loadRecordingHistory();
});

function bindLocalSwitch(id: string, storageKey: string, defaultOn: boolean): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(`#${id}`)!;
  const enabled = (): boolean => {
    const value = localStorage.getItem(storageKey);
    return value === null ? defaultOn : value === "on";
  };
  const sync = (): void => {
    const on = enabled();
    button.classList.toggle("on", on);
    button.setAttribute("aria-checked", String(on));
    button.setAttribute("aria-label", `${button.closest(".setting-row")?.querySelector("strong")?.textContent ?? "Setting"} is ${on ? "on" : "off"}`);
  };
  button.addEventListener("click", () => {
    localStorage.setItem(storageKey, enabled() ? "off" : "on");
    sync();
  });
  sync();
  return button;
}

bindLocalSwitch("live-preview-toggle", "indoor-voice:live-preview", true);
bindLocalSwitch("voice-commands-toggle", "indoor-voice:voice-commands", true);

const transcriptionModelSelect = document.querySelector<HTMLSelectElement>("#transcription-model")!;
transcriptionModelSelect.value = transcriptionModelProfile();
transcriptionModelSelect.addEventListener("change", () => {
  localStorage.setItem("indoor-voice:transcription-model", transcriptionModelSelect.value);
  activeAppProfile = undefined;
  void loadModelStatus();
});

const microphoneDeviceSelect = document.querySelector<HTMLSelectElement>("#microphone-device")!;
const microphoneHelp = document.querySelector<HTMLElement>("#microphone-help")!;
async function loadMicrophones(): Promise<void> {
  if (!isDesktopRuntime) return;
  try {
    const devices = await safeInvoke<AudioInputDevice[]>("list_audio_input_devices");
    const saved = localStorage.getItem("indoor-voice:microphone-device") ?? "";
    microphoneDeviceSelect.innerHTML = `<option value="">System default</option>${devices.map((device) => `<option value="${escapeHtml(device.id)}">${escapeHtml(device.name)}${device.isDefault ? " · Default" : ""}</option>`).join("")}`;
    microphoneDeviceSelect.value = devices.some((device) => device.id === saved) ? saved : "";
    if (saved && !microphoneDeviceSelect.value) localStorage.removeItem("indoor-voice:microphone-device");
    await safeInvoke("set_audio_input_device", { deviceId: microphoneDeviceSelect.value || null });
    microphoneHelp.textContent = devices.length ? `${devices.length} input ${devices.length === 1 ? "device" : "devices"} available.` : "No microphone input was found.";
  } catch (error) {
    microphoneHelp.textContent = error instanceof Error ? error.message : "Microphones could not be listed.";
  }
}
microphoneDeviceSelect.addEventListener("change", async () => {
  const deviceId = microphoneDeviceSelect.value;
  microphoneDeviceSelect.disabled = true;
  try {
    await safeInvoke("set_audio_input_device", { deviceId: deviceId || null });
    if (deviceId) localStorage.setItem("indoor-voice:microphone-device", deviceId);
    else localStorage.removeItem("indoor-voice:microphone-device");
    microphoneHelp.textContent = deviceId ? "This microphone will be used for dictation." : "Indoor Voice will follow the macOS default input.";
  } catch (error) {
    microphoneHelp.textContent = error instanceof Error ? error.message : "That microphone could not be selected.";
  } finally {
    microphoneDeviceSelect.disabled = false;
  }
});
document.querySelector<HTMLButtonElement>("#test-microphone")!.addEventListener("click", async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  button.textContent = "Listening…";
  microphoneHelp.textContent = "Speak normally for a moment.";
  try {
    await safeInvoke("start_audio_capture_with_device", { deviceId: microphoneDeviceSelect.value || null });
    await new Promise((resolve) => window.setTimeout(resolve, 1300));
    const snapshot = await safeInvoke<{ samples: number[] }>("stop_audio_capture");
    microphonePermissionReady = true;
    const seconds = snapshot.samples.length / 16_000;
    microphoneHelp.textContent = seconds > 0.5 ? `Microphone is working · captured ${seconds.toFixed(1)} seconds locally.` : "The microphone opened, but the sample was too short. Try again.";
    syncSetupActions();
  } catch (error) {
    microphoneHelp.textContent = error instanceof Error ? error.message : "The microphone test failed.";
  } finally {
    button.disabled = false;
    button.textContent = "Test";
  }
});

const launchAtLoginToggle = document.querySelector<HTMLButtonElement>("#launch-at-login-toggle")!;
function syncLaunchAtLogin(status: LaunchAtLoginStatus): void {
  launchAtLoginToggle.disabled = !status.supported;
  launchAtLoginToggle.classList.toggle("on", status.enabled);
  launchAtLoginToggle.setAttribute("aria-checked", String(status.enabled));
  launchAtLoginToggle.setAttribute("aria-label", `Launch at login is ${status.enabled ? "on" : "off"}`);
}
async function loadLaunchAtLogin(): Promise<void> {
  try {
    syncLaunchAtLogin(await safeInvoke<LaunchAtLoginStatus>("launch_at_login_status"));
  } catch {
    launchAtLoginToggle.disabled = true;
  }
}
launchAtLoginToggle.addEventListener("click", async () => {
  launchAtLoginToggle.disabled = true;
  try {
    const enabled = launchAtLoginToggle.getAttribute("aria-checked") !== "true";
    syncLaunchAtLogin(await safeInvoke<LaunchAtLoginStatus>("set_launch_at_login", { enabled }));
  } catch (error) {
    document.querySelector("#diagnostic-status")!.textContent = error instanceof Error ? error.message : "Launch at login could not be changed.";
  } finally {
    launchAtLoginToggle.disabled = false;
  }
});

document.querySelector<HTMLButtonElement>("#run-diagnostic")!.addEventListener("click", async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const status = document.querySelector<HTMLElement>("#diagnostic-status")!;
  button.disabled = true;
  button.textContent = "Testing…";
  status.textContent = "Loading the selected model and checking local services…";
  try {
    const report = await safeInvoke<DiagnosticReport>("run_transcription_self_test", { profile: transcriptionModelProfile() });
    const missing = [!report.model.ready && "model", !report.inputDevices.length && "microphone", !report.accessibilityGranted && "text insertion"].filter(Boolean);
    status.textContent = report.ready && !missing.length
      ? `${report.model.name} loaded · ${report.inputDevices.length} microphone ${report.inputDevices.length === 1 ? "input" : "inputs"} · text insertion ready.`
      : `Needs attention: ${missing.join(", ") || report.captureError || report.notes.at(-1) || "review diagnostics"}.`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "The diagnostic could not finish.";
  } finally {
    button.disabled = false;
    button.textContent = "Run Test";
  }
});

async function loadReleaseStatus(): Promise<void> {
  const status = document.querySelector<HTMLElement>("#release-status")!;
  try {
    const release = await safeInvoke<ReleaseDiagnostics>("release_diagnostics");
    status.textContent = release.updateChecksEnabled
      ? `Version ${release.version} · signed update checks enabled.`
      : `Version ${release.version} · local build. Automatic updates activate in a signed release.`;
  } catch {
    status.textContent = "Release information is available in the desktop app.";
  }
}
document.querySelector<HTMLButtonElement>("#check-updates")!.addEventListener("click", async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const status = document.querySelector<HTMLElement>("#release-status")!;
  button.disabled = true;
  status.textContent = "Checking for updates…";
  try {
    const result = await safeInvoke<UpdateCheckResult>("check_for_app_update");
    status.textContent = !result.configured
      ? `Version ${result.currentVersion} · this local build has no signed update channel.`
      : result.updateAvailable
        ? `Version ${result.latestVersion ?? "new"} is available.`
        : `Version ${result.currentVersion} is current.`;
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "The update check failed.";
  } finally {
    button.disabled = false;
  }
});

function smartSpacingEnabled(): boolean {
  return localStorage.getItem("indoor-voice:smart-spacing") !== "off";
}

const smartSpacingToggle = document.querySelector<HTMLButtonElement>("#smart-spacing-toggle")!;
function syncSmartSpacingToggle(): void {
  const enabled = smartSpacingEnabled();
  smartSpacingToggle.classList.toggle("on", enabled);
  smartSpacingToggle.setAttribute("aria-checked", String(enabled));
  smartSpacingToggle.setAttribute("aria-label", `Smart spacing is ${enabled ? "on" : "off"}`);
}
smartSpacingToggle.addEventListener("click", () => {
  localStorage.setItem("indoor-voice:smart-spacing", smartSpacingEnabled() ? "off" : "on");
  syncSmartSpacingToggle();
});
syncSmartSpacingToggle();

const inputModeSelect = document.querySelector<HTMLSelectElement>("#input-mode")!;
const voiceDetectionSelect = document.querySelector<HTMLSelectElement>("#voice-detection")!;
const dictationLanguageSelect = document.querySelector<HTMLSelectElement>("#dictation-language")!;
inputModeSelect.value = inputMode();
voiceDetectionSelect.value = voiceDetectionMode();
dictationLanguageSelect.value = dictationLanguage();

const languageUi: Record<DictationLanguage, { badge: string; help: string }> = {
  "en-he": {
    badge: "English / עברית · Smart",
    help: "Smart bilingual detection compares English and Hebrew directly for every dictation, preventing a neighboring language from being selected by mistake.",
  },
  en: { badge: "English only", help: "Whisper stays locked to English for maximum consistency." },
  he: { badge: "עברית בלבד", help: "Whisper stays locked to Hebrew for maximum consistency." },
  auto: { badge: "Any language · Auto", help: "Whisper automatically detects any supported language on each dictation." },
};

function updateLanguageUi(): void {
  const copy = languageUi[dictationLanguage()];
  document.querySelector("#language-mode-badge")!.textContent = copy.badge;
  document.querySelector("#dictation-language-help")!.textContent = copy.help;
}

function updateInputModeUi(): void {
  const mode = inputMode();
  document.querySelector("#shortcut-action-label")!.textContent = mode === "ptt" ? "Hold" : "Tap";
  document.querySelector("#input-mode-badge")!.textContent = mode === "ptt" ? "PTT · Hold to talk" : "Hands-free · Tap to toggle";
  setShortcutStatus(
    mode === "ptt"
      ? "Hold the shortcut while speaking, then release to transcribe."
      : "Tap once to start listening, then tap again to transcribe.",
  );
}

inputModeSelect.addEventListener("change", () => {
  if (nativeCaptureActive || microphoneStream || captureStarting) {
    inputModeSelect.value = inputMode();
    setShortcutStatus("Stop the current recording before changing input mode.");
    return;
  }
  localStorage.setItem("indoor-voice:input-mode", inputModeSelect.value);
  updateInputModeUi();
});
voiceDetectionSelect.addEventListener("change", () => {
  localStorage.setItem("indoor-voice:voice-detection", voiceDetectionSelect.value);
});
dictationLanguageSelect.addEventListener("change", () => {
  localStorage.setItem("indoor-voice:language", dictationLanguageSelect.value);
  localStorage.setItem("indoor-voice:language-choice:v2", "done");
  updateLanguageUi();
});
updateInputModeUi();
updateLanguageUi();

document.querySelector<HTMLSelectElement>("#preview-provider")!.addEventListener("change", (event) => {
  const provider = (event.target as HTMLSelectElement).value;
  const definition = providers.find((item) => item.id === provider)!;
  document.querySelector<HTMLInputElement>("#preview-model")!.value =
    localStorage.getItem(`indoor-voice:model:${provider}`) ?? definition.defaultModel;
  document.querySelector<HTMLInputElement>("#preview-url")!.disabled = provider !== "local";
  document.querySelector<HTMLInputElement>("#preview-region")!.disabled = provider !== "bedrock";
});

document.querySelector("#run-cleanup")!.addEventListener("click", async () => {
  const status = document.querySelector<HTMLSpanElement>("#cleanup-status")!;
  const output = document.querySelector<HTMLOutputElement>("#preview-output")!;
  status.textContent = "Improving text…";
  output.textContent = "";
  try {
    const result = await safeInvoke<CleanupResult>("cleanup_text", {
      request: {
        provider: document.querySelector<HTMLSelectElement>("#preview-provider")!.value,
        model: document.querySelector<HTMLInputElement>("#preview-model")!.value.trim(),
        base_url: document.querySelector<HTMLInputElement>("#preview-url")!.value.trim(),
        region: document.querySelector<HTMLInputElement>("#preview-region")!.value.trim(),
        transcript: document.querySelector<HTMLTextAreaElement>("#preview-input")!.value,
        instructions: loadCleanupPrompt(),
      },
    });
    status.textContent = "Cleanup test complete";
    output.textContent = applyLocalFormatting(result.text);
    recordCleanupUsage(result.usage);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Couldn’t run the cleanup test. Check the provider settings and try again.";
  }
});

function escapeHtml(value: string): string {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}

function renderDictionary(): void {
  const list = document.querySelector<HTMLDivElement>("#dictionary-list")!;
  if (!dictionaryEntries.length) {
    list.innerHTML = `<div class="empty-state"><strong>No custom words yet</strong><span>Add the spelling Indoor Voice should use.</span></div>`;
    return;
  }
  list.innerHTML = dictionaryEntries.map((entry) => `<div class="dictionary-row" data-dictionary-id="${escapeHtml(entry.id)}"><div><strong>${escapeHtml(entry.written)}</strong><span>When you say “${escapeHtml(entry.spoken)}”</span></div><div class="row-actions"><button class="button dictionary-toggle" type="button">${entry.enabled ? "On" : "Off"}</button><button class="button dictionary-edit" type="button">Edit</button><button class="icon-button dictionary-delete" type="button" aria-label="Remove ${escapeHtml(entry.written)}">×</button></div></div>`).join("");
  list.querySelectorAll<HTMLElement>("[data-dictionary-id]").forEach((row) => {
    const entry = dictionaryEntries.find((item) => item.id === row.dataset.dictionaryId)!;
    row.querySelector<HTMLButtonElement>(".dictionary-toggle")!.addEventListener("click", () => {
      entry.enabled = !entry.enabled;
      saveDictionary(dictionaryEntries);
      renderDictionary();
    });
    row.querySelector<HTMLButtonElement>(".dictionary-edit")!.addEventListener("click", () => {
      const spoken = window.prompt("How is it usually spoken?", entry.spoken)?.trim();
      if (!spoken) return;
      const written = window.prompt("How should it be written?", entry.written)?.trim();
      if (!written) return;
      entry.spoken = spoken;
      entry.written = written;
      entry.updatedAt = new Date().toISOString();
      saveDictionary(dictionaryEntries);
      renderDictionary();
    });
    row.querySelector<HTMLButtonElement>(".dictionary-delete")!.addEventListener("click", () => {
      dictionaryEntries = removeDictionaryEntry(dictionaryEntries, entry.id);
      saveDictionary(dictionaryEntries);
      renderDictionary();
    });
  });
}

function renderSnippets(): void {
  const list = document.querySelector<HTMLDivElement>("#snippet-list")!;
  if (!snippets.length) {
    list.innerHTML = `<div class="empty-state"><strong>No snippets yet</strong><span>Save an address, signature, or frequent reply.</span></div>`;
    return;
  }
  list.innerHTML = snippets.map((snippet) => `<div class="dictionary-row" data-snippet-id="${escapeHtml(snippet.id)}"><div><strong>${escapeHtml(snippet.name)}</strong><span>“${escapeHtml(snippet.spokenTrigger)}” → ${escapeHtml(snippet.content.slice(0, 90))}</span></div><div class="row-actions"><button class="button snippet-toggle" type="button">${snippet.enabled ? "On" : "Off"}</button><button class="icon-button snippet-delete" type="button" aria-label="Remove ${escapeHtml(snippet.name)}">×</button></div></div>`).join("");
  list.querySelectorAll<HTMLElement>("[data-snippet-id]").forEach((row) => {
    const snippet = snippets.find((item) => item.id === row.dataset.snippetId)!;
    row.querySelector<HTMLButtonElement>(".snippet-toggle")!.addEventListener("click", () => {
      snippet.enabled = !snippet.enabled;
      saveSnippets(snippets);
      renderSnippets();
    });
    row.querySelector<HTMLButtonElement>(".snippet-delete")!.addEventListener("click", () => {
      snippets = removeSnippet(snippets, snippet.id);
      saveSnippets(snippets);
      renderSnippets();
    });
  });
}

function renderAppProfiles(): void {
  const list = document.querySelector<HTMLDivElement>("#app-profile-list")!;
  if (!appProfiles.length) {
    list.innerHTML = `<div class="empty-state"><strong>No app profiles yet</strong><span>Add an app name to apply its preferred language and formatting.</span></div>`;
    return;
  }
  list.innerHTML = appProfiles.map((profile) => `<div class="dictionary-row" data-profile-id="${escapeHtml(profile.id)}"><div><strong>${escapeHtml(profile.name)}</strong><span>${escapeHtml(profile.appNames.join(", ") || profile.bundleIdentifiers.join(", "))} · ${escapeHtml(profile.language)} · ${escapeHtml(profile.model)}</span></div><div class="row-actions"><button class="button profile-toggle" type="button">${profile.enabled ? "On" : "Off"}</button><button class="icon-button profile-delete" type="button" aria-label="Remove ${escapeHtml(profile.name)}">×</button></div></div>`).join("");
  list.querySelectorAll<HTMLElement>("[data-profile-id]").forEach((row) => {
    const profile = appProfiles.find((item) => item.id === row.dataset.profileId)!;
    row.querySelector<HTMLButtonElement>(".profile-toggle")!.addEventListener("click", () => {
      profile.enabled = !profile.enabled;
      saveAppProfiles(appProfiles);
      renderAppProfiles();
    });
    row.querySelector<HTMLButtonElement>(".profile-delete")!.addEventListener("click", () => {
      appProfiles = removeAppProfile(appProfiles, profile.id);
      saveAppProfiles(appProfiles);
      renderAppProfiles();
    });
  });
}

document.querySelector("#add-word")!.addEventListener("click", () => {
  const spoken = window.prompt("How will the word usually be spoken?")?.trim();
  if (!spoken) return;
  const written = window.prompt("How should it be written?", spoken)?.trim();
  if (!written) return;
  try {
    dictionaryEntries = [...dictionaryEntries, createDictionaryEntry({ spoken, written })];
    saveDictionary(dictionaryEntries);
    renderDictionary();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "The dictionary entry could not be saved.");
  }
});

document.querySelector("#add-snippet")!.addEventListener("click", () => {
  const name = window.prompt("Snippet name")?.trim();
  if (!name) return;
  const spokenTrigger = window.prompt("What will you say to insert it?", name)?.trim();
  if (!spokenTrigger) return;
  const content = window.prompt("Text to insert") ?? "";
  if (!content) return;
  try {
    snippets = [...snippets, createSnippet({ name, spokenTrigger, content })];
    saveSnippets(snippets);
    renderSnippets();
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "The snippet could not be saved.");
  }
});

document.querySelector("#add-app-profile")!.addEventListener("click", () => {
  const appName = window.prompt("Application name, for example Mail or WhatsApp")?.trim();
  if (!appName) return;
  const languageInput = window.prompt("Language: auto, en, or he", "auto")?.trim().toLowerCase();
  const language = languageInput === "en" || languageInput === "he" ? languageInput : "auto";
  const modelInput = window.prompt("Model: fast, balanced, or best", "balanced")?.trim().toLowerCase();
  const model = modelInput === "fast" || modelInput === "best" ? modelInput : "balanced";
  appProfiles = [...appProfiles, createAppProfile({ name: appName, appNames: [appName], language, model })];
  saveAppProfiles(appProfiles);
  renderAppProfiles();
});

document.querySelector("#export-dictionary")!.addEventListener("click", () => {
  const payload = JSON.stringify({ version: 1, items: dictionaryEntries }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "indoor-voice-dictionary.json";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
});

document.querySelector("#import-dictionary")!.addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file || file.size > 3_000_000) return;
    try {
      const parsed = JSON.parse(await file.text()) as { items?: Array<{ spoken?: string; written?: string }> } | Array<{ spoken?: string; written?: string }>;
      const items = Array.isArray(parsed) ? parsed : parsed.items ?? [];
      const imported = items.slice(0, 1000).flatMap((item) => {
        try {
          return item.spoken && item.written ? [createDictionaryEntry({ spoken: item.spoken, written: item.written })] : [];
        } catch {
          return [];
        }
      });
      dictionaryEntries = [...dictionaryEntries, ...imported];
      saveDictionary(dictionaryEntries);
      renderDictionary();
    } catch {
      window.alert("That dictionary file is not valid.");
    }
  });
  input.click();
});

renderDictionary();
renderSnippets();
renderAppProfiles();

function formatStatsDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes < 60) return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function saveStatistics(statistics: UsageStatistics): void {
  localStorage.setItem(STATS_KEY, JSON.stringify(statistics));
  renderStatistics();
}

function recordDictationStats(audioSeconds: number, text: string): void {
  const statistics = loadStatistics();
  statistics.dictations += 1;
  statistics.audioSeconds += Math.max(0, audioSeconds);
  statistics.words += wordCount(text);
  saveStatistics(statistics);
}

function recordCleanupUsage(usage: CleanupUsage): void {
  const statistics = loadStatistics();
  const key = `${usage.provider}:${usage.model}`;
  const current = statistics.models[key] ?? { ...usage, calls: 0, inputTokens: 0, outputTokens: 0 };
  current.calls += 1;
  current.inputTokens += Math.max(0, usage.inputTokens);
  current.outputTokens += Math.max(0, usage.outputTokens);
  statistics.models[key] = current;
  saveStatistics(statistics);
}

function renderStatistics(): void {
  const statistics = loadStatistics();
  const dictationTime = document.querySelector<HTMLElement>("#stat-dictation-time");
  if (!dictationTime) return;
  const wordsPerMinute = statistics.audioSeconds > 0 ? Math.round(statistics.words / (statistics.audioSeconds / 60)) : 0;
  const typingSeconds = (statistics.words / 40) * 60;
  const savedSeconds = Math.max(0, typingSeconds - statistics.audioSeconds);
  const modelUsage = Object.values(statistics.models).filter(
    (usage) => usage && typeof usage.provider === "string" && typeof usage.model === "string",
  );
  const cloudUsage = modelUsage.filter((usage) => usage.provider !== "local");
  const cloudCalls = cloudUsage.reduce((total, usage) => total + usage.calls, 0);
  const totalCost = cloudUsage.reduce((total, usage) => total + estimatedUsageCost(usage), 0);
  const hasDictations = statistics.dictations > 0;
  document.querySelector<HTMLElement>(".home-glance")!.hidden = !hasDictations || !modelReady || !microphonePermissionReady || !accessibilityReady;
  document.querySelector<HTMLElement>("#stats-empty")!.hidden = hasDictations;
  document.querySelector<HTMLElement>("#stats-summary")!.hidden = !hasDictations;
  document.querySelector<HTMLElement>("#provider-usage-panel")!.hidden = !modelUsage.length;
  document.querySelector<HTMLElement>("#estimate-settings")!.hidden = cloudCalls === 0;
  document.querySelector<HTMLButtonElement>("#reset-stats")!.disabled = !hasDictations && !modelUsage.length;
  document.querySelector("#home-words")!.textContent = Math.round(statistics.words).toLocaleString();
  document.querySelector("#home-time-saved")!.textContent = formatStatsDuration(savedSeconds);
  document.querySelector("#home-dictations")!.textContent = statistics.dictations.toLocaleString();
  dictationTime.textContent = formatStatsDuration(statistics.audioSeconds);
  document.querySelector("#stat-dictation-count")!.textContent = `${statistics.dictations.toLocaleString()} ${statistics.dictations === 1 ? "dictation" : "dictations"}`;
  document.querySelector("#stat-words")!.textContent = Math.round(statistics.words).toLocaleString();
  document.querySelector("#stat-words-rate")!.textContent = wordsPerMinute ? `${wordsPerMinute} words/minute` : "— words/minute";
  document.querySelector("#stat-time-saved")!.textContent = formatStatsDuration(savedSeconds);
  document.querySelector("#stat-api-cost")!.textContent = `$${totalCost.toFixed(totalCost >= 1 ? 2 : 4)}`;
  document.querySelector("#stat-api-calls")!.textContent = `${cloudCalls.toLocaleString()} cloud cleanup ${cloudCalls === 1 ? "call" : "calls"}`;
  const table = document.querySelector<HTMLElement>("#usage-table")!;
  if (!modelUsage.length) {
    table.innerHTML = `<div class="usage-empty"><strong>No cleanup usage yet</strong><span>Provider usage will appear after Text Cleanup runs.</span></div>`;
    return;
  }
  table.innerHTML = `<div class="usage-row usage-head"><span>Provider / model</span><span>Calls</span><span>Input</span><span>Output</span><span>Estimate</span></div>${modelUsage
    .sort((left, right) => right.calls - left.calls)
    .map((usage) => {
      const provider = providers.find((item) => item.id === usage.provider)?.name ?? usage.provider;
      const pricing = loadPricing(usage.provider, usage.model);
      const estimate = usage.provider === "local" ? "Local · $0" : pricing.freeTier ? "Free tier · $0" : `$${estimatedUsageCost(usage).toFixed(4)}`;
      return `<div class="usage-row"><span><strong>${escapeHtml(provider)}</strong><small>${escapeHtml(usage.model)}</small></span><span>${usage.calls.toLocaleString()}</span><span>${usage.inputTokens.toLocaleString()}</span><span>${usage.outputTokens.toLocaleString()}</span><span>${estimate}</span></div>`;
    })
    .join("")}`;
}

const pricingProviderSelect = document.querySelector<HTMLSelectElement>("#pricing-provider")!;
const pricingModelInput = document.querySelector<HTMLInputElement>("#pricing-model")!;
const pricingInputRate = document.querySelector<HTMLInputElement>("#pricing-input")!;
const pricingOutputRate = document.querySelector<HTMLInputElement>("#pricing-output")!;
const pricingFreeTier = document.querySelector<HTMLInputElement>("#pricing-free-tier")!;

function syncPricingEditor(): void {
  const provider = pricingProviderSelect.value;
  const definition = providers.find((item) => item.id === provider)!;
  const model = localStorage.getItem(`indoor-voice:model:${provider}`) ?? definition.defaultModel;
  pricingModelInput.value = model;
  const pricing = loadPricing(provider, model);
  pricingInputRate.value = String(pricing.inputPerMillion);
  pricingOutputRate.value = String(pricing.outputPerMillion);
  pricingFreeTier.checked = pricing.freeTier;
}

pricingProviderSelect.addEventListener("change", syncPricingEditor);
pricingModelInput.addEventListener("change", () => {
  const pricing = loadPricing(pricingProviderSelect.value, pricingModelInput.value.trim());
  pricingInputRate.value = String(pricing.inputPerMillion);
  pricingOutputRate.value = String(pricing.outputPerMillion);
  pricingFreeTier.checked = pricing.freeTier;
});
document.querySelector("#save-pricing")!.addEventListener("click", () => {
  const provider = pricingProviderSelect.value;
  const model = pricingModelInput.value.trim();
  const inputPerMillion = Number(pricingInputRate.value);
  const outputPerMillion = Number(pricingOutputRate.value);
  const status = document.querySelector<HTMLElement>("#pricing-status")!;
  if (!model || !Number.isFinite(inputPerMillion) || !Number.isFinite(outputPerMillion) || inputPerMillion < 0 || outputPerMillion < 0) {
    status.textContent = "Enter a model and valid non-negative input/output rates.";
    return;
  }
  localStorage.setItem(pricingKey(provider, model), JSON.stringify({ inputPerMillion, outputPerMillion, freeTier: pricingFreeTier.checked } satisfies ModelPricing));
  status.textContent = pricingFreeTier.checked ? "Saved · this model is estimated at $0 on free tier." : "Saved · statistics recalculated with these rates.";
  renderStatistics();
});
document.querySelector("#reset-stats")!.addEventListener("click", () => {
  if (!window.confirm("Reset all local dictation and API usage statistics? This cannot be undone.")) return;
  localStorage.removeItem(STATS_KEY);
  renderStatistics();
});
syncPricingEditor();
renderStatistics();

async function bindNativeShortcut(): Promise<void> {
  try {
    await listen("cancel-processing-request", () => void cancelProcessing());
    await listen<{ paused: boolean }>("capture-pause-request", (event) => void setCapturePaused(event.payload.paused));
    await listen("capture-cancel-request", () => void cancelMicrophoneCapture());
    const control = await safeInvoke<DictationControlStatus>("dictation_control_status");
    dictationPaused = control.paused;
    await listen<DictationControlEvent>("dictation-control-request", (event) => {
      dictationPaused = event.payload.paused;
      if (event.payload.action === "toggle") {
        if (nativeCaptureActive || microphoneStream) void finishMicrophoneCapture(true);
        else if (!captureStarting && !dictationPaused) void startMicrophoneCapture("toggle");
      } else if (event.payload.action === "pause") {
        if (nativeCaptureActive || microphoneStream) void finishMicrophoneCapture(false);
        demoMessage.textContent = "Dictation paused from the menu bar.";
      } else {
        demoMessage.textContent = "Dictation resumed. Your shortcut is ready.";
      }
    });
    await listen<string>("voice-shortcut", (event) => {
      if (shortcutCapturing || dictationPaused) return;
      if (event.payload === "pressed" && processingActive) {
        void cancelProcessing();
        return;
      }
      const mode = inputMode();
      if (mode === "toggle") {
        if (event.payload !== "pressed") return;
        if (nativeCaptureActive || microphoneStream) void finishMicrophoneCapture(true);
        else if (!captureStarting) void startMicrophoneCapture("toggle");
        return;
      }
      if (event.payload === "pressed" && !listening && !captureStarting) {
        void startMicrophoneCapture("ptt");
      } else if (event.payload === "released") {
        if (captureStarting) releaseRequested = true;
        else if (nativeCaptureActive || microphoneStream) void finishMicrophoneCapture(true);
      }
    });
  } catch {
    // Browser preview has no native event bus.
  }
}

async function bindModelEvents(): Promise<void> {
  try {
    await listen<PillLevelEvent>("pill-level", (event) => updateWaveformLevel(event.payload.level));
    await listen<DownloadProgress>("model-download-progress", (event) => {
      const progress = document.querySelector<HTMLDivElement>("#model-progress")!;
      progress.hidden = false;
      progress.querySelector("i")!.setAttribute("style", `width:${event.payload.percent}%`);
      document.querySelector("#model-setup-detail")!.textContent = `Downloading verified model… ${event.payload.percent}%`;
    });
    await listen("model-download-complete", () => void loadModelStatus());
  } catch {
    // Browser preview has no native event bus.
  }
}

syncAppearanceControls();
applyCurrentPillCustomization(false);
updateWaveformLevel(0.32);
setPillState("idle");
syncSetupActions();
void loadCapabilities();
void loadModelStatus();
void loadMicrophones();
void loadLaunchAtLogin();
void loadReleaseStatus();
void refreshAccessibilityStatus();
void bindNativeShortcut();
void bindModelEvents();
void loadRecordingHistory();
