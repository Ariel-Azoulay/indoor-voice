export type AppFormattingPreset = "standard" | "email" | "message" | "notes";

export interface EmailFormattingOptions {
  greeting?: string;
  closing?: string;
  signature?: string;
}

export interface AppFormattingOptions extends EmailFormattingOptions {
  preset?: AppFormattingPreset;
}

const SALUTATION = /^(dear|hello|hi|hey|good morning|good afternoon|good evening|שלום|היי|בוקר טוב|ערב טוב)\b/iu;

function normalizedBlock(value: string | undefined): string {
  return (value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function startsWithBlock(text: string, block: string): boolean {
  return text.toLocaleLowerCase().startsWith(block.toLocaleLowerCase());
}

function endsWithBlock(text: string, block: string): boolean {
  return text.toLocaleLowerCase().endsWith(block.toLocaleLowerCase());
}

export function formatEmail(text: string, options: EmailFormattingOptions = {}): string {
  let body = text.replace(/\r\n?/g, "\n").trim();
  if (!body) return body;

  const greeting = normalizedBlock(options.greeting);
  const closing = normalizedBlock(options.closing);
  const signature = normalizedBlock(options.signature);

  if (greeting && !startsWithBlock(body, greeting)) {
    body = `${greeting}\n\n${body}`;
  } else if (!greeting && SALUTATION.test(body)) {
    const firstBreak = body.indexOf("\n");
    const firstComma = body.search(/[,،]/u);
    if (firstComma >= 0 && (firstBreak < 0 || firstComma < firstBreak)) {
      const salutation = body.slice(0, firstComma + 1).trim();
      const remainder = body.slice(firstComma + 1).trim();
      if (remainder) body = `${salutation}\n\n${remainder}`;
    }
  }

  const signOff = [closing, signature].filter(Boolean).join("\n");
  if (signOff && !endsWithBlock(body, signOff)) body = `${body}\n\n${signOff}`;
  return body.replace(/\n{3,}/g, "\n\n");
}

export function applyAppFormatting(text: string, options: AppFormattingOptions = {}): string {
  const preset = options.preset ?? "standard";
  if (preset === "email") return formatEmail(text, options);
  if (preset === "message") return text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (preset === "notes") return text.replace(/\r\n?/g, "\n").trim();
  return text;
}
