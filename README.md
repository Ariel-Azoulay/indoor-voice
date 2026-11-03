# Indoor Voice

Indoor Voice is an open-source, local-first desktop dictation application. Its default privacy boundary is simple: microphone audio is transcribed on the computer, and transcript text leaves the computer only when the user explicitly enables a cloud cleanup provider.

## What works

- Tauri 2 desktop shell with a native Rust security boundary.
- Animated dictation pill with nine screen anchors, adjustable size/margins, optional labels, and per-element colors.
- Real microphone capture and 16 kHz mono resampling in the desktop app.
- Local multilingual Whisper inference through whisper.cpp, with no transcription API required.
- One-click 142 MB model download with exact size and SHA-256 verification before loading.
- Direct insertion into the previously focused application through macOS Accessibility.
- Optional cassette-inspired local recording archive with real WAV playback and transcripts.
- Native global shortcut with push-to-talk and tap-to-toggle hands-free modes (`Option + Space` on macOS; `Ctrl + Win + Space` elsewhere).
- Adaptive speech detection trims leading/trailing silence and rejects silence or steady background noise before Whisper runs.
- English, Hebrew, and multilingual language modes, with script-mismatch rejection before cloud cleanup or pasting.
- Provider secrets stored in macOS Keychain, Windows Credential Manager, or Linux Secret Service.
- Working local OpenAI-compatible cleanup adapter, restricted to loopback endpoints.
- Working OpenAI Responses cleanup adapter with `store: false`.
- Working Anthropic Messages, Google Gemini, and Amazon Bedrock cleanup adapters.
- Bedrock supports its scoped bearer API keys and keeps the selected region as a non-secret preference.
- Editable cleanup prompt and per-provider model identifier, with a best-practice dictation editor prompt included.
- Correction-aware output validation that permits explicit self-corrections while protecting the final number, email address, and URL.
- Local statistics for dictation time, words produced, estimated typing time saved, provider token usage, and estimated API cost.
- No audio upload, transcript telemetry, or automatic cloud fallback.

Apple SpeechTranscriber is still a future alternative engine. The current production path uses local Whisper on every supported platform.

## First run on macOS

1. Open **Indoor Voice** and choose **Download 142 MB**.
2. Choose **Enable microphone** and approve the macOS permission prompt.
3. Hold `Option + Space` while speaking, then release it. Or choose **Hands-free** under **Privacy → Input mode** and tap once to start, once to stop.
4. Approve Accessibility access when macOS asks; this lets Indoor Voice type the result into the app you were using.

Cleanup is **Off** by default. Recording history is also **Off** by default; enable it under **Privacy → Recording history** if you want WAV files and transcripts kept in the local cassette archive.

## Customization

The **Appearance** screen updates the real floating pill immediately. The sound-reactive multicolor brand wave is the default listening visualization, while the classic vertical level bars remain available. Users can also choose any point on a 3×3 screen grid, screen margin, pill scale, label visibility, surface opacity, shadow depth, and separate colors for the surface, text, live indicator, success, error, idle glow, and border. These non-secret preferences are validated against a versioned schema and stored locally.

The **Privacy** screen controls push-to-talk versus hands-free input and offers Balanced, Noisy room, and Quiet voice detection profiles. Silent captures return immediately without invoking Whisper or an AI cleanup provider.

Choose the expected spoken language under **Privacy → Audio**. English is the safe default; Hebrew and Automatic are available when needed. A transcript that unexpectedly switches scripts is rejected before cleanup or insertion. Clearly contextual compact times are normalized locally, so “meet at 1500 tomorrow” becomes “meet at 15:00 tomorrow.”

The **Statistics** screen stores aggregate usage only on this computer. Cloud providers contribute the input and output token counts returned by their APIs. Cost is an estimate based on editable per-million-token rates; users on a provider's free tier can mark that model as free so the estimate remains $0.

The **AI providers** screen exposes the active provider's model identifier and cleanup instructions. The included default prompt handles grammar, speech-recognition errors, filler words, abandoned phrases, explicit corrections, headings, and bullet lists. The native layer adds a non-editable safety envelope and validates the returned text before insertion.

## Provider routes

| Route | Credential | Network boundary |
| --- | --- | --- |
| Local | None | Loopback only (`localhost`, `127.0.0.1`, or `::1`) |
| OpenAI | API key in OS vault | Fixed OpenAI HTTPS endpoint |
| Anthropic | API key in OS vault | Fixed Anthropic HTTPS endpoint |
| Google Gemini | API key in OS vault | Fixed Google HTTPS endpoint |
| Amazon Bedrock | Bedrock API key in OS vault | Fixed regional AWS HTTPS endpoint |

## Development

On macOS, build the installable app with `npm run build:mac`. This applies a
stable local code-signing requirement so the Accessibility permission remains
valid after rebuilding. Running `tauri build` directly produces a hash-based
ad-hoc identity that macOS treats as a different app after every code change.

```bash
npm install
npm run tauri dev
```

Run checks:

```bash
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
```

No API key is required to build or run the app. A user can add a provider key from **AI providers**; the plaintext value is immediately handed to the native credential vault and cleared from the form.

The bundled Whisper model is derived from OpenAI's open-source Whisper weights and runs through the open-source whisper.cpp inference engine. The app verifies the reviewed model SHA-256 before loading it.

## License

MIT. See [LICENSE](./LICENSE).

## Security posture

Read [SECURITY.md](./SECURITY.md) before adding new providers, logging, telemetry, remote content, custom endpoints, or model download code.
