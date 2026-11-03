export type ListStyle = "dashes" | "dots" | "numbers" | "letters";

export const LIST_STYLE_KEY = "indoor-voice:list-style:v1";
export const DEFAULT_LIST_STYLE: ListStyle = "numbers";

const spokenNumberWords = new Map<string, number>([
  ["one", 1], ["first", 1],
  ["two", 2], ["second", 2],
  ["three", 3], ["third", 3],
  ["four", 4], ["fourth", 4],
  ["five", 5], ["fifth", 5],
  ["six", 6], ["sixth", 6],
  ["seven", 7], ["seventh", 7],
  ["eight", 8], ["eighth", 8],
  ["nine", 9], ["ninth", 9],
  ["ten", 10], ["tenth", 10],
  ["eleven", 11], ["eleventh", 11],
  ["twelve", 12], ["twelfth", 12],
  ["אחד", 1], ["אחת", 1], ["ראשון", 1], ["ראשונה", 1],
  ["שניים", 2], ["שתיים", 2], ["שני", 2], ["שנייה", 2], ["שניייה", 2],
  ["שלושה", 3], ["שלוש", 3], ["שלישי", 3], ["שלישית", 3],
  ["ארבעה", 4], ["ארבע", 4], ["רביעי", 4], ["רביעית", 4],
  ["חמישה", 5], ["חמש", 5], ["חמישי", 5], ["חמישית", 5],
  ["שישה", 6], ["שש", 6], ["שישי", 6], ["שישית", 6],
  ["שבעה", 7], ["שבע", 7], ["שביעי", 7], ["שביעית", 7],
  ["שמונה", 8], ["שמיני", 8], ["שמינית", 8],
  ["תשעה", 9], ["תשע", 9], ["תשיעי", 9], ["תשיעית", 9],
  ["עשרה", 10], ["עשר", 10], ["עשירי", 10], ["עשירית", 10],
  ["אחד עשר", 11], ["אחת עשרה", 11],
  ["שנים עשר", 12], ["שתים עשרה", 12],
]);

const markerWordsPattern = [...spokenNumberWords.keys()]
  .sort((a, b) => b.length - a.length)
  .map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+"))
  .join("|");

const markerPattern = new RegExp(
  `(^|[\\s,:;.!?؟،])([1-9]|1[0-2]|${markerWordsPattern})(?:\\s*[.)])?(?=\\s|[,;:\\-–—])`,
  "giu",
);

interface ListMarker {
  value: number;
  start: number;
  contentStart: number;
}

function markerValue(raw: string): number {
  const numeric = Number.parseInt(raw, 10);
  return Number.isFinite(numeric) ? numeric : spokenNumberWords.get(raw.toLocaleLowerCase().replace(/\s+/gu, " ")) ?? 0;
}

function skipMarkerSeparator(text: string, start: number): number {
  let index = start;
  while (index < text.length && /[\s,;:\-–—]/u.test(text[index])) index += 1;
  return index;
}

function cleanItem(value: string): string {
  return value
    .trim()
    .replace(/(?:,\s*)?(?:and|then|ו|ואז|אז)\s*$/iu, "")
    .replace(/[\s,;:.]+$/u, "")
    .trim();
}

function itemPrefix(style: ListStyle, index: number): string {
  if (style === "dashes") return "-";
  if (style === "dots") return "•";
  if (style === "letters") return `${String.fromCharCode(65 + index)}.`;
  return `${index + 1}.`;
}

function formatExistingListBlocks(text: string, style: ListStyle): string {
  const lines = text.split("\n");
  const itemPattern = /^(\s*)(?:[-•◦]\s+|\d+[.)]\s+|[A-Z][.)]\s+)(\S.*)$/iu;
  let index = 0;
  while (index < lines.length) {
    const start = index;
    const items: Array<{ indent: string; text: string }> = [];
    while (index < lines.length) {
      const match = itemPattern.exec(lines[index]);
      if (!match) break;
      items.push({ indent: match[1], text: match[2] });
      index += 1;
    }
    if (items.length >= 2) {
      items.forEach((item, itemIndex) => {
        lines[start + itemIndex] = `${item.indent}${itemPrefix(style, itemIndex)} ${item.text}`;
      });
    }
    if (index === start) index += 1;
  }
  return lines.join("\n");
}

export function normalizeListStyle(value: string | null | undefined): ListStyle {
  return value === "dashes" || value === "dots" || value === "letters" || value === "numbers"
    ? value
    : DEFAULT_LIST_STYLE;
}

export function parseSpokenListNumber(value: string): number | undefined {
  const parsed = markerValue(value.trim());
  return parsed >= 1 && parsed <= 12 ? parsed : undefined;
}

export function formatSpokenLists(text: string, style: ListStyle): string {
  const normalizedText = formatExistingListBlocks(text, style);
  const markers: ListMarker[] = [];
  markerPattern.lastIndex = 0;
  for (let match = markerPattern.exec(normalizedText); match; match = markerPattern.exec(normalizedText)) {
    const leading = match[1] ?? "";
    markers.push({
      value: markerValue(match[2]),
      start: match.index + leading.length,
      contentStart: skipMarkerSeparator(normalizedText, markerPattern.lastIndex),
    });
  }

  for (let start = 0; start < markers.length; start += 1) {
    if (markers[start].value !== 1) continue;
    let end = start + 1;
    while (end < markers.length && markers[end].value === markers[end - 1].value + 1) end += 1;
    if (end - start < 3) continue;

    const run = markers.slice(start, end);
    const items = run.map((marker, index) => {
      const boundary = run[index + 1]?.start ?? normalizedText.length;
      return cleanItem(normalizedText.slice(marker.contentStart, boundary));
    });
    if (items.some((item) => !item || !/\p{L}/u.test(item))) continue;

    const prefix = normalizedText.slice(0, run[0].start).trimEnd().replace(/[\s,;]+$/u, "");
    const formatted = items.map((item, index) => `${itemPrefix(style, index)} ${item}`).join("\n");
    return prefix ? `${prefix}\n${formatted}` : formatted;
  }

  return normalizedText;
}
