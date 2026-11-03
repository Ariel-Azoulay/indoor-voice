import type { PillState } from "./types";

interface PillContentTransitionOptions {
  pill: HTMLElement;
  content: HTMLElement;
  markup: string;
  fromState: PillState;
  toState: PillState;
  reuseContent?: boolean;
  reducedMotion?: boolean;
}

interface RunningTransition {
  incoming?: Animation;
  outgoing?: Animation;
  outgoingElement?: HTMLElement;
}

const runningTransitions = new WeakMap<HTMLElement, RunningTransition>();

function removeOutgoing(pill: HTMLElement, transition?: RunningTransition): void {
  transition?.outgoing?.cancel();
  transition?.outgoingElement?.remove();
  pill.querySelectorAll<HTMLElement>(":scope > .pill-content-outgoing").forEach((element) => element.remove());
}

export function cancelPillContentTransition(pill: HTMLElement): void {
  const transition = runningTransitions.get(pill);
  transition?.incoming?.cancel();
  removeOutgoing(pill, transition);
  runningTransitions.delete(pill);
}

function incomingFrames(fromState: PillState, toState: PillState, reducedMotion: boolean): Keyframe[] {
  if (reducedMotion) return [{ opacity: 0 }, { opacity: 1 }];
  if (fromState === "idle" && (toState === "listening" || toState === "handsfree")) {
    return [
      { opacity: 0, transform: "scaleX(.16) scaleY(.68)", filter: "blur(2px)" },
      { opacity: .72, transform: "scaleX(.78) scaleY(.92)", filter: "blur(.35px)", offset: .52 },
      { opacity: 1, transform: "scale(1)", filter: "blur(0)" },
    ];
  }
  if (toState === "success" || toState === "error") {
    return [
      { opacity: 0, transform: "scale(.58)", filter: "blur(1.2px)" },
      { opacity: 1, transform: "scale(1)", filter: "blur(0)" },
    ];
  }
  if (toState === "idle") {
    return [
      { opacity: 0, transform: "scaleX(.45) scaleY(.78)" },
      { opacity: 1, transform: "scale(1)" },
    ];
  }
  return [
    { opacity: 0, transform: "scale(.92)", filter: "blur(.8px)" },
    { opacity: 1, transform: "scale(1)", filter: "blur(0)" },
  ];
}

function outgoingFrames(fromState: PillState, toState: PillState, start: CSSStyleDeclaration, reducedMotion: boolean): Keyframe[] {
  const first: Keyframe = {
    opacity: start.opacity,
    transform: start.transform === "none" ? "scale(1)" : start.transform,
    filter: start.filter === "none" ? "blur(0)" : start.filter,
  };
  if (reducedMotion) return [first, { opacity: 0 }];
  if (fromState === "idle" && (toState === "listening" || toState === "handsfree")) {
    return [first, { opacity: 0, transform: "scaleX(2.2) scaleY(.55)", filter: "blur(1.5px)" }];
  }
  if (toState === "idle") {
    return [first, { opacity: 0, transform: "scaleX(.24) scaleY(.66)", filter: "blur(1.4px)" }];
  }
  return [first, { opacity: 0, transform: "scale(.72)", filter: "blur(1.2px)" }];
}

function freezeOutgoingPresentation(source: HTMLElement, clone: HTMLElement): void {
  const sources = [source, ...source.querySelectorAll<HTMLElement>("*")];
  const clones = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
  sources.forEach((element, index) => {
    const clonedElement = clones[index];
    if (!clonedElement) return;
    const style = getComputedStyle(element);
    clonedElement.style.width = style.width;
    clonedElement.style.height = style.height;
    clonedElement.style.transform = style.transform;
    clonedElement.style.opacity = style.opacity;
    clonedElement.style.filter = style.filter;
    clonedElement.style.borderRadius = style.borderRadius;
    clonedElement.style.background = style.background;
    clonedElement.style.boxShadow = style.boxShadow;
    clonedElement.style.color = style.color;
  });
}

export function transitionPillContent({
  pill,
  content,
  markup,
  fromState,
  toState,
  reuseContent = false,
  reducedMotion = false,
}: PillContentTransitionOptions): void {
  const previous = runningTransitions.get(pill);
  if (reuseContent) {
    removeOutgoing(pill, previous);
    if (previous?.incoming?.playState === "running") {
      previous.outgoing = undefined;
      previous.outgoingElement = undefined;
      runningTransitions.set(pill, previous);
    } else {
      runningTransitions.delete(pill);
    }
    return;
  }

  const presentation = getComputedStyle(content);
  const hasOutgoingContent = content.childNodes.length > 0;
  const outgoing = hasOutgoingContent ? content.cloneNode(true) as HTMLElement : undefined;
  if (outgoing) {
    freezeOutgoingPresentation(content, outgoing);
    if (fromState === "working" && toState === "success") {
      const spinner = outgoing.querySelector<HTMLElement>(".brand-waveform");
      if (spinner) spinner.style.width = "26px";
    }
  }
  previous?.incoming?.cancel();
  removeOutgoing(pill, previous);

  if (outgoing) {
    outgoing.classList.add("pill-content-outgoing");
    outgoing.setAttribute("aria-hidden", "true");
    outgoing.style.opacity = presentation.opacity;
    outgoing.style.transform = presentation.transform;
    outgoing.style.filter = presentation.filter;
    pill.append(outgoing);
  }

  content.innerHTML = markup;
  const duration = reducedMotion ? 150
    : fromState === "idle" && (toState === "listening" || toState === "handsfree") ? 390
      : fromState === toState ? 190 : 290;
  const easing = reducedMotion ? "ease-out" : "cubic-bezier(.2,.75,.2,1)";
  const incoming = content.animate(incomingFrames(fromState, toState, reducedMotion), { duration, easing, fill: "both" });
  const outgoingAnimation = outgoing?.animate(
    outgoingFrames(fromState, toState, presentation, reducedMotion),
    { duration: reducedMotion ? 120 : Math.min(duration, 260), easing: "cubic-bezier(.4,0,.6,1)", fill: "both" },
  );
  const transition: RunningTransition = { incoming, outgoing: outgoingAnimation, outgoingElement: outgoing };
  runningTransitions.set(pill, transition);

  outgoingAnimation?.addEventListener("finish", () => outgoing?.remove(), { once: true });
  incoming.addEventListener("finish", () => {
    if (runningTransitions.get(pill) !== transition) return;
    incoming.cancel();
    outgoing?.remove();
    runningTransitions.delete(pill);
  }, { once: true });
}
