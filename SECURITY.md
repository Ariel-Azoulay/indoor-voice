# Security policy and implementation constraints

## Data classes

1. **Audio** — most sensitive. Memory-only by default; never sent to cleanup providers.
2. **Transcript and context** — sensitive. Sent only to an explicitly selected cleanup route.
3. **Provider credentials** — secrets. Stored only in the operating-system credential vault.
4. **Preferences** — non-secret. May be stored in ordinary local application storage.

Custom cleanup instructions and model identifiers are preferences, not credentials. They must never be concatenated with secrets or written to logs.

## Non-negotiable rules

- Never log audio, transcripts, prompts, model responses, authorization headers, keys, AWS credentials, or surrounding-screen context.
- Never place credentials in environment files, JSON, SQLite, localStorage, URLs, command-line arguments, crash reports, or analytics.
- Never silently fall back from an on-device engine to a network engine.
- Never let the webview call provider APIs directly.
- Never load remote web content inside a window with native capabilities.
- Local model endpoints must resolve to loopback addresses only.
- Cloud endpoints must use HTTPS and fixed, reviewed hostnames.
- Model downloads must use fixed reviewed URLs, strict size limits, and verified hashes before loading.
- Context awareness must be opt-in and must exclude passwords, payment fields, banking apps, and other sensitive surfaces.
- Any new Tauri permission must receive a focused security review.

## Provider adapter checklist

- Store credentials in the OS vault.
- Minimize request content.
- Disable provider-side storage where supported.
- Use a fixed hostname and TLS verification.
- Apply timeouts and response-size limits.
- Validate that the response preserves addresses, URLs, explicit terms, and the final intended number after any spoken self-correction.
- Clear temporary plaintext values as soon as practical.
- Return a user-safe error without provider response bodies.

## Reporting vulnerabilities

Until a public security address exists, open a private security advisory in the repository. Do not include real credentials, transcripts, recordings, or personal data.
