const MOJIBAKE_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["‚Ä¢", "•"], ["â€¢", "•"],
  ["‚Äî", "—"], ["â€”", "—"],
  ["‚Äì", "–"], ["â€“", "–"],
  ["‚Ä¶", "…"], ["â€¦", "…"],
  ["‚Äò", "‘"], ["â€˜", "‘"],
  ["‚Äô", "’"], ["â€™", "’"],
  ["‚Äú", "“"], ["â€œ", "“"],
  ["‚Äù", "”"], ["â€", "”"],
  ["¬©", "©"], ["Â©", "©"],
  ["¬Æ", "®"], ["Â®", "®"],
  ["¬°", "°"], ["Â°", "°"],
  ["¬†", " "], ["Â ", " "],
];

/** Repairs only known, unambiguous encoding artifacts. It intentionally avoids
 * broad byte reinterpretation, which can damage valid Hebrew and emoji. */
export function repairKnownMojibake(text: string): string {
  let repaired = text;
  for (const [broken, expected] of MOJIBAKE_REPLACEMENTS) {
    repaired = repaired.split(broken).join(expected);
  }
  return repaired;
}

export function normalizeUnicodeText(
  text: string,
  normalizationForm: "NFC" | "NFKC" = "NFC",
): string {
  return repairKnownMojibake(text).normalize(normalizationForm);
}
