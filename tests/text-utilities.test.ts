import {
  applyDictionary,
  createDictionaryEntry,
  loadDictionary,
  saveDictionary,
  type DictionaryEntry,
} from "../src/dictionary";
import { createSnippet, applySnippets, loadSnippets, saveSnippets } from "../src/snippets";
import { formatSpokenLists, parseSpokenListNumber } from "../src/list-formatting";
import { applyVoiceFormattingCommands } from "../src/voice-formatting";
import { normalizeUnicodeText, repairKnownMojibake } from "../src/unicode-text";
import {
  createAppProfile,
  loadAppProfiles,
  resolveAppProfile,
  saveAppProfiles,
} from "../src/app-profiles";
import type { KeyValueStorage } from "../src/local-store";
import { processLocalTranscript } from "../src/text-processing";

class MemoryStorage implements KeyValueStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function equal<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}\nExpected: ${JSON.stringify(expected)}\nActual:   ${JSON.stringify(actual)}`);
  }
}

function ok(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}

function fixedDictionaryEntry(spoken: string, written: string, overrides: Partial<DictionaryEntry> = {}): DictionaryEntry {
  return {
    ...createDictionaryEntry({ spoken, written }, new Date("2026-01-01T00:00:00.000Z")),
    ...overrides,
  };
}

function testDictionary(): void {
  const entries = [
    fixedDictionaryEntry("chat g p t", "ChatGPT"),
    fixedDictionaryEntry("אינדור וויס", "Indoor Voice"),
  ];
  equal(
    applyDictionary("Use chat g p t עם אינדור וויס 😀", entries),
    "Use ChatGPT עם Indoor Voice 😀",
    "Dictionary handles English, Hebrew, and emoji",
  );
  equal(applyDictionary("concatenate cat", [fixedDictionaryEntry("cat", "dog")]), "concatenate dog", "Whole-word matching");
  equal(
    applyDictionary("spoken voice", [fixedDictionaryEntry("spoken voice", "my email"), fixedDictionaryEntry("my email", "wrong")]),
    "my email",
    "Dictionary replacements never cascade",
  );

  const storage = new MemoryStorage();
  saveDictionary(entries, storage);
  equal(loadDictionary(storage).length, 2, "Dictionary persists locally");
}

function testSnippets(): void {
  const snippet = createSnippet({
    name: "Email",
    spokenTrigger: "insert my email",
    content: "hello@example.com",
  }, new Date("2026-01-01T00:00:00.000Z"));
  equal(applySnippets("Please insert my email here.", [snippet]), "Please hello@example.com here.", "Snippet expansion");
  const storage = new MemoryStorage();
  saveSnippets([snippet], storage);
  equal(loadSnippets(storage)[0]?.content, "hello@example.com", "Snippets persist locally");
}

function testLists(): void {
  equal(
    formatSpokenLists("Shopping one apples two bread three milk", "numbers"),
    "Shopping\n1. apples\n2. bread\n3. milk",
    "English cardinal list",
  );
  equal(
    formatSpokenLists("Tasks first call Sam second send mail third rest", "dashes"),
    "Tasks\n- call Sam\n- send mail\n- rest",
    "English ordinal list",
  );
  equal(
    formatSpokenLists("לקניות אחד תפוחים שתיים לחם שלוש חלב", "dots"),
    "לקניות\n• תפוחים\n• לחם\n• חלב",
    "Hebrew cardinal list",
  );
  equal(
    formatSpokenLists("משימות ראשונה להתקשר שנייה לשלוח הודעה שלישית לנוח", "letters"),
    "משימות\nA. להתקשר\nB. לשלוח הודעה\nC. לנוח",
    "Hebrew ordinal list",
  );
  equal(formatSpokenLists("1) alpha\n2) beta\n3) gamma", "dots"), "• alpha\n• beta\n• gamma", "Existing list restyle");
  equal(parseSpokenListNumber("אחת עשרה"), 11, "Hebrew compound cardinal");
  equal(parseSpokenListNumber("twelfth"), 12, "English ordinal parser");
}

function testVoiceCommands(): void {
  equal(
    applyVoiceFormattingCommands("Hello comma world exclamation mark new paragraph How are you question mark"),
    "Hello, world!\n\nHow are you?",
    "English formatting commands",
  );
  equal(
    applyVoiceFormattingCommands("שלום פסיק עולם סימן קריאה שורה חדשה מה נשמע סימן שאלה"),
    "שלום, עולם!\nמה נשמע?",
    "Hebrew formatting commands",
  );
  equal(
    applyVoiceFormattingCommands("bullet list one apples two pears three bananas", { listStyle: "numbers" }),
    "• apples\n• pears\n• bananas",
    "Spoken list cue overrides the default style",
  );
  equal(
    applyVoiceFormattingCommands("רשימה ממוספרת אחת תפוחים שתיים אגסים שלוש בננות", { listStyle: "dashes" }),
    "1. תפוחים\n2. אגסים\n3. בננות",
    "Hebrew list cue",
  );
}

function testUnicode(): void {
  equal(repairKnownMojibake("Items ‚Ä¢ one ‚Äî two"), "Items • one — two", "Known app mojibake repair");
  equal(normalizeUnicodeText("שָׁלוֹם 😀 — café"), "שָׁלוֹם 😀 — café", "Valid Hebrew, emoji, and Latin stay intact");
  equal(normalizeUnicodeText("Cafe\u0301 שלום"), "Café שלום", "NFC normalization preserves mixed direction text");
}

function testProfiles(): void {
  const mail = createAppProfile({
    name: "Mail Hebrew",
    appNames: ["Mail"],
    bundleIdentifiers: ["com.apple.mail"],
    language: "he",
    listStyle: "dots",
  }, new Date("2026-01-01T00:00:00.000Z"));
  const notes = createAppProfile({ name: "Notes", appNames: ["Notes"], language: "en" });
  equal(resolveAppProfile([notes, mail], { bundleIdentifier: "COM.APPLE.MAIL", name: "Other" })?.id, mail.id, "Bundle match wins");
  equal(resolveAppProfile([notes, mail], { name: " notes " })?.id, notes.id, "App-name fallback is normalized");
  const storage = new MemoryStorage();
  saveAppProfiles([mail, notes], storage);
  const loaded = loadAppProfiles(storage);
  equal(loaded.length, 2, "Profiles persist locally");
  ok(loaded[0]?.dictionaryEnabled, "Profile feature flags survive persistence");
}

function testCombinedPipeline(): void {
  const dictionary = [fixedDictionaryEntry("new lion", "new line")];
  const snippet = createSnippet({ name: "Sign-off", spokenTrigger: "insert sign off", content: "Best,\nAriel" });
  equal(
    processLocalTranscript("שלום ‚Ä¢ new lion insert sign off", { dictionary, snippets: [snippet] }),
    "שלום •\nBest,\nAriel",
    "Combined pipeline repairs text, applies dictionary commands, and expands snippets",
  );
}

testDictionary();
testSnippets();
testLists();
testVoiceCommands();
testUnicode();
testProfiles();
testCombinedPipeline();

console.log("Text utility tests passed.");
