import { applyDictionary, type DictionaryEntry } from "./dictionary";
import { formatSpokenLists, type ListStyle } from "./list-formatting";
import { applySnippets, type Snippet } from "./snippets";
import { normalizeUnicodeText } from "./unicode-text";
import { applyVoiceFormattingCommands } from "./voice-formatting";

export interface LocalTextProcessingOptions {
  dictionary?: readonly DictionaryEntry[];
  snippets?: readonly Snippet[];
  listStyle?: ListStyle;
  voiceCommandsEnabled?: boolean;
  listsEnabled?: boolean;
  unicodeNormalization?: "NFC" | "NFKC" | false;
}

/** The deterministic, fully local post-transcription pipeline used before cleanup/insertion. */
export function processLocalTranscript(text: string, options: LocalTextProcessingOptions = {}): string {
  const normalization = options.unicodeNormalization === undefined ? "NFC" : options.unicodeNormalization;
  let output = normalization ? normalizeUnicodeText(text, normalization) : text;
  output = applyDictionary(output, options.dictionary ?? []);

  if (options.voiceCommandsEnabled !== false) {
    output = applyVoiceFormattingCommands(output, {
      listStyle: options.listStyle,
      formatLists: options.listsEnabled !== false,
    });
  } else if (options.listsEnabled !== false) {
    output = formatSpokenLists(output, options.listStyle ?? "numbers");
  }

  return applySnippets(output, options.snippets ?? []);
}
