let waveformInstance = 0;

const WAVE_WIDTH = 192;
// Keep the SVG and its CSS box at the same 4.8:1 aspect ratio. The previous
// 3:1 viewBox was letterboxed inside a much wider element, which made the
// waveform look small while leaving a large amount of invisible side space.
const WAVE_HEIGHT = 40;
const MAX_WAVE_LINES = 13;
const WAVE_SEGMENTS = 48;
const WAVE_PHASE_OFFSETS = [-0.85, 0.42, 1.18, -1.32, 0.7, 0, -0.55, 1.5, -1, 0.95, -0.2, 1.28, -1.55];
const WAVE_FREQUENCIES = [4.8, 5.8, 6.4, 5.2, 7, 6, 5.5, 6.7, 4.9, 6.2, 5.7, 6.9, 5.1];
const WAVE_AMPLITUDES = [0.56, 0.72, 0.92, 0.66, 1.08, 0.82, 0.58, 1, 0.74, 0.9, 0.62, 0.78, 0.68];
const WAVE_OPACITIES = [0.62, 0.68, 0.82, 0.96, 0.74, 0.9, 1, 0.72, 0.92, 0.78, 0.88, 0.7, 0.64];

export interface WaveformEffect {
  startColor: string;
  middleColor: string;
  endColor: string;
  lineCount: number;
  thickness: number;
  separation: number;
  reactivity: number;
  speed: number;
}

export const DEFAULT_WAVEFORM_EFFECT: WaveformEffect = {
  // The three editable anchors trace the approved icon palette: cyan flows
  // through blue into magenta, then through orange/yellow and back via green.
  startColor: "#00dff3",
  middleColor: "#ff2ea6",
  endColor: "#ffd60a",
  lineCount: 9,
  thickness: 0.62,
  separation: 1.22,
  reactivity: 1.2,
  speed: 1,
};

type WaveformMode = "idle" | "listening" | "thinking";
type Point = [number, number];

interface WaveformAnimationState {
  mode: WaveformMode;
  currentLevel: number;
  targetLevel: number;
  filteredInput: number;
  gateOpen: boolean;
  phase: number;
  effect: WaveformEffect;
  frameId?: number;
  lastTimestamp?: number;
  modeStartedAt?: number;
}

const waveformStates = new WeakMap<HTMLElement, WaveformAnimationState>();

function animationState(element: HTMLElement): WaveformAnimationState {
  const existing = waveformStates.get(element);
  if (existing) return existing;
  const created: WaveformAnimationState = {
    mode: "idle",
    currentLevel: 0,
    targetLevel: 0,
    filteredInput: 0,
    gateOpen: false,
    phase: 0,
    effect: { ...DEFAULT_WAVEFORM_EFFECT },
  };
  waveformStates.set(element, created);
  return created;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function easeInOut(value: number): number {
  const progress = clamp(value);
  return progress < 0.5 ? 4 * progress ** 3 : 1 - ((-2 * progress + 2) ** 3) / 2;
}

function activeLineRange(effect: WaveformEffect): [number, number] {
  const count = Math.max(5, Math.min(MAX_WAVE_LINES, Math.round(effect.lineCount) | 1));
  const first = Math.floor((MAX_WAVE_LINES - count) / 2);
  return [first, first + count - 1];
}

function wavePoints(globalIndex: number, lineOffset: number, phase: number, level: number, effect: WaveformEffect): Point[] {
  const reaction = effect.reactivity;
  const gap = (0.7 + level * 1.1 * reaction) * effect.separation;
  const amplitude = (3.8 + level * 2.8 * reaction) * WAVE_AMPLITUDES[globalIndex];
  const linePhase = phase * (1 + lineOffset * 0.006) + WAVE_PHASE_OFFSETS[globalIndex];
  const points: Point[] = [];

  for (let segment = 0; segment <= WAVE_SEGMENTS; segment += 1) {
    const progress = segment / WAVE_SEGMENTS;
    const x = progress * WAVE_WIDTH;
    const envelope = Math.sin(Math.PI * progress) ** 0.7;
    const primary = Math.sin(progress * Math.PI * WAVE_FREQUENCIES[globalIndex] - linePhase);
    const detailFrequency = 8.4 + (globalIndex % 3) * 0.55;
    const detail = Math.sin(progress * Math.PI * detailFrequency + linePhase * 0.68) * 0.14;
    const y = WAVE_HEIGHT / 2
      + lineOffset * gap * envelope
      + (primary + detail) * amplitude * envelope;
    points.push([x, y]);
  }
  return points;
}

function pathFromPoints(points: Point[]): string {
  return points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
}

function prepareLines(element: HTMLElement, effect: WaveformEffect): Array<{ line: SVGPathElement; globalIndex: number; lineOffset: number }> {
  const [first, last] = activeLineRange(effect);
  const center = (first + last) / 2;
  const active: Array<{ line: SVGPathElement; globalIndex: number; lineOffset: number }> = [];
  element.querySelectorAll<SVGPathElement>(".brand-waveform path").forEach((line, globalIndex) => {
    const visible = globalIndex >= first && globalIndex <= last;
    line.style.display = visible ? "" : "none";
    if (visible) active.push({ line, globalIndex, lineOffset: globalIndex - center });
  });
  return active;
}

function resetWaveformPresentation(element: HTMLElement): void {
  element.querySelector<SVGGElement>(".brand-waveform-lines")?.removeAttribute("transform");
  element.querySelectorAll<SVGLinearGradientElement>(".brand-waveform-gradient").forEach((gradient) => {
    gradient.setAttribute("x1", "0");
    gradient.setAttribute("x2", String(WAVE_WIDTH));
  });
  element.querySelectorAll<SVGPathElement>(".brand-waveform path").forEach((line) => {
    line.style.removeProperty("opacity");
    line.style.removeProperty("stroke-width");
    line.removeAttribute("transform");
    line.removeAttribute("stroke-dasharray");
    line.removeAttribute("stroke-dashoffset");
  });
}

function renderWaveform(element: HTMLElement, phase: number, level: number, effect: WaveformEffect): void {
  resetWaveformPresentation(element);
  prepareLines(element, effect).forEach(({ line, globalIndex, lineOffset }) => {
    line.setAttribute("d", pathFromPoints(wavePoints(globalIndex, lineOffset, phase, level, effect)));
  });
}

function renderThinkingWaveform(element: HTMLElement, elapsed: number, state: WaveformAnimationState): void {
  const active = prepareLines(element, state.effect);
  const visibleRingCount = Math.min(5, active.length);
  const retainedIndices = Array.from({ length: visibleRingCount }, (_, index) => (
    Math.round(index * (active.length - 1) / Math.max(1, visibleRingCount - 1))
  ));
  const flatten = easeInOut(elapsed / 360);
  const curl = easeInOut((elapsed - 300) / 500);
  const orbitElapsed = Math.max(0, elapsed - 620);
  const group = element.querySelector<SVGGElement>(".brand-waveform-lines");
  group?.removeAttribute("transform");
  element.querySelectorAll<SVGLinearGradientElement>(".brand-waveform-gradient").forEach((gradient) => {
    gradient.setAttribute("x1", "80");
    gradient.setAttribute("x2", "112");
  });

  active.forEach(({ line, globalIndex, lineOffset }, activeIndex) => {
    const starting = wavePoints(globalIndex, lineOffset, state.phase, state.currentLevel, state.effect);
    const retainedSlot = retainedIndices.indexOf(activeIndex);
    const retained = retainedSlot >= 0;
    const opticalSlot = retained ? retainedSlot : visibleRingCount / 2;
    const opticalCenter = (visibleRingCount - 1) / 2;
    const distanceFromCenter = Math.abs(opticalSlot - opticalCenter) / Math.max(1, opticalCenter);
    const baseRadius = 9.4 + opticalSlot * 1.05 * state.effect.separation;
    const direction = opticalSlot % 2 === 0 ? 1 : -1;
    const orbitSpeed = 0.64 + opticalSlot * 0.16;
    const shapePhase = lineOffset * 0.76;
    const rotation = (orbitElapsed * 0.075 * state.effect.speed * direction * orbitSpeed) % 360;
    const secondaryLobes = 3 + (activeIndex % 3);
    const points = starting.map(([startX, startY], segment): Point => {
      const progress = segment / WAVE_SEGMENTS;
      const lineX = progress * WAVE_WIDTH;
      const lineY = WAVE_HEIGHT / 2;
      const flattenedX = startX + (lineX - startX) * flatten;
      const flattenedY = startY + (lineY - startY) * flatten;
      const angle = progress * Math.PI * 2 - Math.PI / 2;
      // The first harmonic creates one unmistakable rotating high point. A
      // smaller secondary harmonic keeps each orbit organic and distinct.
      const ripple = Math.sin(angle + shapePhase) * (0.9 + distanceFromCenter * 0.34)
        + Math.sin(angle * secondaryLobes - shapePhase * 0.54) * 0.28;
      const radius = baseRadius + ripple * curl;
      const circleX = WAVE_WIDTH / 2 + Math.cos(angle) * radius;
      const circleY = WAVE_HEIGHT / 2 + Math.sin(angle) * radius;
      return [flattenedX + (circleX - flattenedX) * curl, flattenedY + (circleY - flattenedY) * curl];
    });
    line.setAttribute("d", pathFromPoints(points));
    line.setAttribute("transform", `rotate(${(rotation * curl).toFixed(2)} ${WAVE_WIDTH / 2} ${WAVE_HEIGHT / 2})`);
    const targetOpacity = retained ? 0.54 + (1 - distanceFromCenter) * 0.3 : 0;
    const startingOpacity = WAVE_OPACITIES[globalIndex];
    line.style.opacity = String(startingOpacity + (targetOpacity - startingOpacity) * curl);
    line.style.strokeWidth = `${(state.effect.thickness
      * (0.7 + (1 - distanceFromCenter) * 0.1)).toFixed(2)}px`;
    // The rings themselves communicate progress. There is deliberately no
    // separate dashed spinner layered beneath them.
    line.removeAttribute("stroke-dasharray");
    line.removeAttribute("stroke-dashoffset");
  });
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function runWaveformFrame(element: HTMLElement, timestamp: number): void {
  const state = animationState(element);
  if (state.mode === "idle") {
    state.frameId = undefined;
    state.lastTimestamp = undefined;
    return;
  }

  const elapsed = Math.min(34, Math.max(0, timestamp - (state.lastTimestamp ?? timestamp)));
  state.lastTimestamp = timestamp;
  if (state.modeStartedAt === undefined) state.modeStartedAt = timestamp;

  if (state.mode === "thinking") {
    const thinkingElapsed = reducedMotion() ? 860 : timestamp - state.modeStartedAt;
    renderThinkingWaveform(element, thinkingElapsed, state);
  } else {
    const response = state.targetLevel > state.currentLevel ? 55 : 170;
    const blend = 1 - Math.exp(-elapsed / response);
    state.currentLevel += (state.targetLevel - state.currentLevel) * blend;
    state.phase += elapsed * (0.00215 + state.currentLevel * 0.00135) * state.effect.speed;
    renderWaveform(element, state.phase, state.currentLevel, state.effect);
  }

  if (reducedMotion()) {
    state.frameId = undefined;
    state.lastTimestamp = undefined;
    return;
  }
  state.frameId = window.requestAnimationFrame((nextTimestamp) => runWaveformFrame(element, nextTimestamp));
}

export function brandWaveformMarkup(): string {
  const gradientId = `indoor-voice-wave-${waveformInstance += 1}`;
  const [defaultFirstLine, defaultLastLine] = activeLineRange(DEFAULT_WAVEFORM_EFFECT);
  return `<span class="brand-waveform" aria-hidden="true">
    <svg viewBox="0 0 ${WAVE_WIDTH} ${WAVE_HEIGHT}" focusable="false">
      <defs>
        <linearGradient class="brand-waveform-gradient" id="${gradientId}" x1="0" y1="20" x2="192" y2="20" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="var(--wave-color-start, #00dff3)"/>
          <stop offset=".08" stop-color="var(--wave-color-start, #00dff3)"/>
          <stop offset=".42" stop-color="var(--wave-color-middle, #ff2ea6)"/>
          <stop offset=".68" stop-color="var(--wave-color-end, #ffd60a)"/>
          <stop offset="1" stop-color="var(--wave-color-start, #00dff3)"/>
        </linearGradient>
      </defs>
      <g class="brand-waveform-lines">
        ${Array.from({ length: MAX_WAVE_LINES }, (_, index) => `<path data-wave-line="${index}" style="--wave-opacity:${WAVE_OPACITIES[index]};${index < defaultFirstLine || index > defaultLastLine ? "display:none" : ""}" d="${pathFromPoints(wavePoints(index, index - (MAX_WAVE_LINES - 1) / 2, 0, 0, DEFAULT_WAVEFORM_EFFECT))}" stroke="url(#${gradientId})"/>`).join("")}
      </g>
    </svg>
  </span>`;
}

export function applyWaveformEffect(element: HTMLElement, effect: WaveformEffect): void {
  const state = animationState(element);
  state.effect = { ...effect };
  element.style.setProperty("--wave-color-start", effect.startColor);
  element.style.setProperty("--wave-color-middle", effect.middleColor);
  element.style.setProperty("--wave-color-end", effect.endColor);
  element.style.setProperty("--wave-thickness", effect.thickness.toFixed(2));
  if (state.mode === "idle") renderWaveform(element, state.phase, state.currentLevel, state.effect);
}

export function setWaveformMode(element: HTMLElement, mode: WaveformMode): void {
  const state = animationState(element);
  if (state.mode !== mode) {
    state.mode = mode;
    state.modeStartedAt = undefined;
    state.lastTimestamp = undefined;
    if (mode === "listening") {
      state.gateOpen = false;
      state.filteredInput = 0;
      state.targetLevel = 0;
      state.currentLevel = Math.min(state.currentLevel, .04);
    }
  }
  if (mode === "idle") {
    if (state.frameId !== undefined) window.cancelAnimationFrame(state.frameId);
    state.frameId = undefined;
    state.lastTimestamp = undefined;
    resetWaveformPresentation(element);
    return;
  }
  if (state.frameId === undefined) {
    state.frameId = window.requestAnimationFrame((timestamp) => runWaveformFrame(element, timestamp));
  }
}

export function setWaveformActive(element: HTMLElement, active: boolean): void {
  setWaveformMode(element, active ? "listening" : "idle");
}

export function applyWaveformLevel(element: HTMLElement, rawLevel: number): number {
  const level = Number.isFinite(rawLevel) ? clamp(rawLevel) : 0;
  const state = animationState(element);

  // Microphones always have a small ambient floor. Hysteresis prevents that
  // floor from repeatedly opening and closing the visual response while the
  // user is quiet, and the asymmetric filter keeps speech responsive without
  // making its release twitchy.
  if (state.gateOpen && level < .055) state.gateOpen = false;
  else if (!state.gateOpen && level > .11) state.gateOpen = true;
  const gatedLevel = state.gateOpen ? clamp((level - .07) / .93) : 0;
  const filterAmount = gatedLevel > state.filteredInput ? .42 : .16;
  state.filteredInput += (gatedLevel - state.filteredInput) * filterAmount;
  if (!state.gateOpen && state.filteredInput < .008) state.filteredInput = 0;

  const visualLevel = state.filteredInput === 0
    ? 0
    : Math.min(1, Math.pow(state.filteredInput, .72) * 1.18);
  state.targetLevel = visualLevel;
  element.style.setProperty("--brand-wave-level", visualLevel.toFixed(3));
  element.style.setProperty("--brand-wave-brightness", (1 + visualLevel * 0.15).toFixed(3));
  element.style.setProperty("--brand-wave-saturation", (0.92 + visualLevel * 0.22).toFixed(3));
  element.style.setProperty("--brand-wave-opacity", (0.94 + visualLevel * 0.06).toFixed(3));
  if (state.mode === "idle" || reducedMotion()) renderWaveform(element, state.phase, visualLevel, state.effect);
  return visualLevel;
}
