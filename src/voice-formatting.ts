import { formatSpokenLists, type ListStyle } from "./list-formatting";
import { applyTextReplacements, type TextReplacement } from "./text-replacements";

export interface VoiceFormattingOptions {
  listStyle?: ListStyle;
  formatLists?: boolean;
}

const LINE_COMMANDS: readonly TextReplacement[] = [
  { trigger: "new paragraph", replacement: "\n\n" },
  { trigger: "paragraph break", replacement: "\n\n" },
  { trigger: "פסקה חדשה", replacement: "\n\n" },
  { trigger: "new line", replacement: "\n" },
  { trigger: "line break", replacement: "\n" },
  { trigger: "שורה חדשה", replacement: "\n" },
];

const PUNCTUATION_COMMANDS: readonly TextReplacement[] = [
  { trigger: "question mark", replacement: "?" },
  { trigger: "exclamation point", replacement: "!" },
  { trigger: "exclamation mark", replacement: "!" },
  { trigger: "full stop", replacement: "." },
  { trigger: "semicolon", replacement: ";" },
  { trigger: "colon", replacement: ":" },
  { trigger: "comma", replacement: "," },
  { trigger: "period", replacement: "." },
  { trigger: "סימן שאלה", replacement: "?" },
  { trigger: "סימן קריאה", replacement: "!" },
  { trigger: "נקודה פסיק", replacement: ";" },
  { trigger: "נקודתיים", replacement: ":" },
  { trigger: "פסיק", replacement: "," },
  { trigger: "נקודה", replacement: "." },
];

const LIST_CUES: ReadonlyArray<readonly [ListStyle | undefined, readonly string[]]> = [
  ["dots", ["bulleted list", "bullet list", "רשימת תבליטים"]],
  ["dashes", ["dash list", "hyphen list", "רשימת מקפים"]],
  ["numbers", ["numbered list", "number list", "רשימה ממוספרת"]],
  ["letters", ["lettered list", "letter list", "רשימת אותיות"]],
  [undefined, ["start list", "begin list", "התחל רשימה", "רשימה חדשה"]],
];

export function applyVoiceFormattingCommands(text: string, options: VoiceFormattingOptions = {}): string {
  let requestedListStyle: ListStyle | undefined;
  const cueReplacements: TextReplacement[] = [];
  for (const [style, cues] of LIST_CUES) {
    for (const cue of cues) {
      if (containsWholePhrase(text, cue)) requestedListStyle ??= style;
      cueReplacements.push({ trigger: cue, replacement: "\n", wholeWord: true });
    }
  }

  let formatted = applyTextReplacements(text, [...LINE_COMMANDS, ...PUNCTUATION_COMMANDS, ...cueReplacements]);
  formatted = normalizeCommandSpacing(formatted);
  if (options.formatLists !== false) {
    formatted = formatSpokenLists(formatted, requestedListStyle ?? options.listStyle ?? "numbers");
  }
  return formatted.trim();
}

function containsWholePhrase(text: string, phrase: string): boolean {
  return applyTextReplacements(text, [{ trigger: phrase, replacement: "\u0000", wholeWord: true }]).includes("\u0000");
}

function normalizeCommandSpacing(text: string): string {
  return text
    .replace(/[ \t]+([,.;:!?])/gu, "$1")
    .replace(/([,;:!?])(?=[\p{L}\p{N}])/gu, "$1 ")
    .replace(/\.(?=[\p{L}\p{N}])/gu, ". ")
    .replace(/[ \t]*\n[ \t]*/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n");
}
