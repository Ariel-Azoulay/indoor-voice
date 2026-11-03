import "./overlay.css";
import "./overlay-compact.css";
import "./waveform.css";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import type { PillState } from "./types";
import { applyPillCustomization, loadPillCustomization, normalizePillCustomization, stateCustomization, type PillCustomization } from "./customization";
import { applyWaveformLevel, brandWaveformMarkup, setWaveformMode } from "./waveform";
import { cancelPillContentTransition, transitionPillContent } from "./pill-motion";

interface PillStateEvent { state: PillState; message?: string }
interface PillLevelEvent { level: number }
interface PillAppContext { name?: string | null; bundleIdentifier?: string | null; iconDataUrl?: string | null }

const root = document.querySelector<HTMLElement>("#overlay-root");
if (!root) throw new Error("Overlay root not found");

root.innerHTML = `
  <div class="pill-cluster idle" id="pill-cluster">
    <div class="screen-pill idle" id="screen-pill" role="status" aria-label="Ready">
      <span class="pill-content"><span class="idle-glow"></span></span>
    </div>
    <button class="pill-cancel-detached" id="pill-cancel" type="button" aria-label="Cancel transcription" aria-hidden="true" disabled>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg>
    </button>
  </div>
  <div class="sr-only" id="pill-status" role="status" aria-live="polite" aria-atomic="true"></div>
  <div class="sr-only" id="pill-alert" role="alert" aria-live="assertive" aria-atomic="true"></div>`;

const pill = document.querySelector<HTMLElement>("#screen-pill")!;
const cluster = document.querySelector<HTMLElement>("#pill-cluster")!;
const cancelButton = document.querySelector<HTMLButtonElement>("#pill-cancel")!;
const contentElement = document.querySelector<HTMLElement>(".pill-content")!;
const politeStatus = document.querySelector<HTMLElement>("#pill-status")!;
const assertiveAlert = document.querySelector<HTMLElement>("#pill-alert")!;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let currentState: PillState = "idle";
let currentMessage: string | undefined;
let lastAnnouncement = "";
let geometryAnimation: Animation | undefined;
let customization = loadPillCustomization();
let currentContentMode = stateCustomization(customization, currentState).contentMode;
let currentApp: PillAppContext = {};
let capturePaused = false;

function bars(): string {
  return `<span class="overlay-bars">${[0.58, 0.86, 1, 0.7, 0.94, 0.63, 0.82, 0.48]
    .map((height) => `<i style="--height:${height}"></i>`).join("")}</span>`;
}

function stateLabel(state: PillState): string {
  return { idle: "Ready", listening: "Listening", handsfree: "Hands-free listening", working: "Transcribing", success: "Text inserted", error: "Couldn't transcribe" }[state];
}

function transformOriginFor(position: PillCustomization["position"]): string {
  const [vertical, horizontal] = position === "center" ? ["center", "center"] : position.split("-");
  const x = horizontal === "left" || horizontal === "right" ? horizontal : "center";
  const y = vertical === "top" || vertical === "bottom" ? vertical : "center";
  return `${x} ${y}`;
}

function announcementFor(state: PillState, message?: string): string {
  if (state === "error") return message ? `Couldn't transcribe. ${message}` : "Couldn't transcribe. Try again.";
  return stateLabel(state);
}

function announce(state: PillState, message?: string): void {
  const announcement = announcementFor(state, message);
  if (announcement === lastAnnouncement) return;
  lastAnnouncement = announcement;
  politeStatus.textContent = "";
  assertiveAlert.textContent = "";
  if (state === "error") assertiveAlert.textContent = announcement;
  else politeStatus.textContent = announcement;
}

function usesExpandedListening(state: PillState): boolean {
  return customization.listeningLayout === "expanded" && (state === "listening" || state === "handsfree");
}

function appIdentityMarkup(): string {
  const name = currentApp.name?.trim() || "Current app";
  const icon = currentApp.iconDataUrl?.startsWith("data:image/png;base64,")
    ? `<img src="${currentApp.iconDataUrl}" alt="" />`
    : `<span aria-hidden="true">${escapeHtml(name.slice(0, 1).toLocaleUpperCase())}</span>`;
  return `<span class="expanded-app-icon" title="${escapeHtml(name)}" aria-label="Dictating into ${escapeHtml(name)}">${icon}</span>`;
}

function expandedListeningMarkup(message: string | undefined, mode: PillCustomization["contentMode"]): string {
  const visual = mode === "levels" ? bars() : brandWaveformMarkup();
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
  const stage = stateCustomization(customization, state);
  const mode = stage.contentMode;
  if (usesExpandedListening(state)) return expandedListeningMarkup(message, mode);
  const statusLabel = `<strong dir="auto">${escapeHtml(stateLabel(state))}</strong>`;
  const transcriptText = state === "success" && message
    ? message
    : state === "listening" || state === "handsfree"
      ? message ?? "Listening…"
      : state === "error" && message
        ? message
      : state === "working" ? "Processing speech…" : stateLabel(state);
  const transcriptLabel = `<strong class="transcript-label" dir="auto">${escapeHtml(transcriptText)}</strong>`;
  const workIndicator = stage.showIndicator ? `<span class="working-dots"><i></i><i></i><i></i></span>` : "";
  const successIndicator = stage.showIndicator ? `<span class="success-mark">✓</span>` : "";
  const errorIndicator = stage.showIndicator ? `<span class="error-mark">!</span>` : "";
  const idleIndicator = stage.showIndicator ? `<span class="idle-glow"></span>` : "";
  const visualOnly = mode === "levels" || mode === "waveform";
  const listeningVisual = mode === "waveform" ? brandWaveformMarkup() : bars();
  const listeningContent = visualOnly ? listeningVisual : mode === "transcript" ? transcriptLabel : statusLabel;
  const workingVisual = mode === "waveform" ? brandWaveformMarkup() : workIndicator;
  const workingContent = visualOnly ? workingVisual : `${workIndicator}${mode === "transcript" ? transcriptLabel : `<strong>Transcribing…</strong>`}`;
  return {
    idle: visualOnly ? idleIndicator : `${idleIndicator}${mode === "transcript" ? transcriptLabel : statusLabel}`,
    listening: listeningContent,
    handsfree: listeningContent,
    working: workingContent,
    success: `${successIndicator}${visualOnly ? "" : mode === "transcript" ? transcriptLabel : statusLabel}`,
    error: `${errorIndicator}${visualOnly ? "" : mode === "transcript" ? transcriptLabel : `<strong>${escapeHtml(message ?? "Try again")}</strong>`}`,
  }[state];
}

function springFrames(fromWidth: number, fromHeight: number, toWidth: number, toHeight: number): Keyframe[] {
  const frames: Keyframe[] = [];
  const samples = 28;
  for (let index = 0; index <= samples; index += 1) {
    const t = index / samples;
    const x = 7.2 * t;
    const progress = 1 - (1 + x) * Math.exp(-x);
    frames.push({ width: `${fromWidth + (toWidth - fromWidth) * progress}px`, height: `${fromHeight + (toHeight - fromHeight) * progress}px`, offset: t });
  }
  frames[frames.length - 1] = { width: `${toWidth}px`, height: `${toHeight}px`, offset: 1 };
  return frames;
}

function render(state: PillState, message?: string, shouldAnnounce = true): void {
  if (state === currentState && usesExpandedListening(state) && !capturePaused && message) {
    const liveText = contentElement.querySelector<HTMLElement>(".expanded-live-text");
    const pauseButton = contentElement.querySelector<HTMLElement>("[data-capture-pause]");
    if (liveText && pauseButton?.getAttribute("aria-pressed") === String(capturePaused)) {
      liveText.textContent = message;
      currentMessage = message;
      if (shouldAnnounce) announce(state, message);
      return;
    }
  }
  const scale = customization.scale;
  const currentRect = pill.getBoundingClientRect();
  const previousState = currentState;
  const previousContentMode = currentContentMode;
  const stage = stateCustomization(customization, state);
  const keepsLivingWave = !usesExpandedListening(state) && previousContentMode === "waveform"
    && stage.contentMode === "waveform"
    && contentElement.querySelector(".brand-waveform") !== null
    && (previousState === "listening" || previousState === "handsfree" || previousState === "working")
    && (state === "listening" || state === "handsfree" || state === "working");
  const morphsFromSpinner = currentState === "working"
    && state === "success"
    && stateCustomization(customization, "working").contentMode === "waveform";
  geometryAnimation?.cancel();
  const fromWidth = currentRect.width / scale;
  const fromHeight = currentRect.height / scale;
  transitionPillContent({
    pill,
    content: contentElement,
    markup: pillMarkup(state, message),
    fromState: previousState,
    toState: state,
    reuseContent: keepsLivingWave,
    reducedMotion: reducedMotion.matches,
  });
  currentState = state;
  currentMessage = message;
  const expandedClass = usesExpandedListening(state) ? " expanded-listening" : "";
  cluster.className = `pill-cluster ${state}${expandedClass}${morphsFromSpinner ? " spinner-to-success" : ""}`;
  applyPillCustomization(cluster, customization, state);
  pill.style.width = "";
  pill.style.height = "";
  pill.className = `screen-pill ${state}${expandedClass}${capturePaused ? " capture-paused" : ""}${morphsFromSpinner ? " spinner-to-success" : ""}`;
  applyPillCustomization(pill, customization, state);
  pill.dataset.contentMode = stage.contentMode;
  if (state === "idle" && stage.contentMode !== "levels" && stage.contentMode !== "waveform") {
    pill.style.width = "auto";
    pill.style.minWidth = "74px";
    pill.style.height = "32px";
    pill.style.padding = "0 11px";
    pill.style.background = "color-mix(in srgb, var(--pill-background) var(--pill-background-opacity), transparent)";
  } else {
    pill.style.minWidth = "";
    pill.style.padding = "";
    pill.style.background = "";
  }
  setWaveformMode(pill, stage.contentMode !== "waveform"
    ? "idle"
    : state === "working" ? "thinking"
      : state === "listening" || state === "handsfree" ? "listening" : "idle");
  cancelButton.disabled = state !== "working";
  cancelButton.setAttribute("aria-hidden", String(state !== "working"));
  pill.setAttribute("aria-label", announcementFor(state, message));
  void invoke("set_pill_interactive", { interactive: state === "working" || usesExpandedListening(state) }).catch(() => {
    // Browser preview has no native pill window.
  });
  const targetRect = pill.getBoundingClientRect();
  const toWidth = targetRect.width / scale;
  const toHeight = targetRect.height / scale;
  if (!reducedMotion.matches && (Math.abs(fromWidth - toWidth) > 0.5 || Math.abs(fromHeight - toHeight) > 0.5)) {
    const animation = pill.animate(springFrames(fromWidth, fromHeight, toWidth, toHeight), { duration: 420, easing: "linear", fill: "both" });
    geometryAnimation = animation;
    animation.onfinish = () => {
      if (geometryAnimation !== animation) return;
      animation.cancel();
      pill.style.width = "";
      pill.style.height = "";
      geometryAnimation = undefined;
    };
  }
  currentContentMode = stage.contentMode;
  if (shouldAnnounce) announce(state, message);
}

function escapeHtml(value: string): string {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}

void listen<PillStateEvent>("pill-state", (event) => render(event.payload.state, event.payload.message));
void listen<PillLevelEvent>("pill-level", (event) => {
  const rawLevel = Number.isFinite(event.payload.level) ? Math.min(1, Math.max(0, event.payload.level)) : 0;
  const level = applyWaveformLevel(pill, rawLevel);
  pill.style.setProperty("--audio-level", level.toFixed(3));
});
void listen<PillCustomization>("pill-customization", (event) => {
  customization = normalizePillCustomization(event.payload);
  root.dataset.position = customization.position;
  applyPillCustomization(pill, customization, currentState);
  pill.style.transformOrigin = transformOriginFor(customization.position);
  render(currentState, currentMessage, false);
});
void listen<PillAppContext>("pill-app-context", (event) => {
  currentApp = event.payload;
  if (usesExpandedListening(currentState)) render(currentState, currentMessage, false);
});
void listen<{ paused: boolean }>("pill-capture-paused", (event) => {
  capturePaused = event.payload.paused;
  if (usesExpandedListening(currentState)) render(currentState, currentMessage, false);
});
reducedMotion.addEventListener("change", () => {
  geometryAnimation?.cancel();
  cancelPillContentTransition(pill);
  render(currentState, currentMessage, false);
});
cancelButton.addEventListener("click", () => {
  void emit("cancel-processing-request");
});
pill.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("[data-capture-pause]")) void emit("capture-pause-request", { paused: !capturePaused });
  if (target.closest("[data-capture-cancel]")) void emit("capture-cancel-request");
});

root.dataset.position = customization.position;
applyPillCustomization(pill, customization, currentState);
applyPillCustomization(cluster, customization, currentState);
applyWaveformLevel(pill, 0);
pill.style.transformOrigin = transformOriginFor(customization.position);
render("idle", undefined, false);
