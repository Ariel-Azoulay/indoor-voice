export interface TextReplacement {
  trigger: string;
  replacement: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  enabled?: boolean;
}

interface ReplacementMatch {
  start: number;
  end: number;
  replacement: string;
  priority: number;
}

const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_]/u;

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function triggerPattern(trigger: string): string {
  return escapeRegex(trigger.trim()).replace(/\s+/gu, "\\s+");
}

function isWordCharacter(value: string | undefined): boolean {
  return Boolean(value && WORD_CHARACTER.test(value));
}

/**
 * Applies all matches against the original text, so replacement values can never
 * cascade into a second replacement. Longer triggers win at the same position.
 */
export function applyTextReplacements(text: string, replacements: readonly TextReplacement[]): string {
  const matches: ReplacementMatch[] = [];

  replacements.forEach((entry, priority) => {
    const trigger = entry.trigger.trim();
    if (!trigger || entry.enabled === false) return;
    const regex = new RegExp(triggerPattern(trigger), entry.caseSensitive ? "gu" : "giu");
    for (let match = regex.exec(text); match; match = regex.exec(text)) {
      const start = match.index;
      const end = start + match[0].length;
      if (entry.wholeWord !== false) {
        if (isWordCharacter(text[start - 1]) || isWordCharacter(text[end])) continue;
      }
      matches.push({ start, end, replacement: entry.replacement, priority });
      if (match[0].length === 0) regex.lastIndex += 1;
    }
  });

  matches.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start) || a.priority - b.priority);
  const selected: ReplacementMatch[] = [];
  let cursor = -1;
  for (const match of matches) {
    if (match.start < cursor) continue;
    selected.push(match);
    cursor = match.end;
  }
  if (selected.length === 0) return text;

  let output = "";
  cursor = 0;
  for (const match of selected) {
    output += text.slice(cursor, match.start);
    output += match.replacement;
    cursor = match.end;
  }
  return output + text.slice(cursor);
}
