#!/bin/sh
set -eu

indoor_voice_app="src-tauri/target/release/bundle/macos/Indoor Voice.app"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Stable local signing is only required on macOS."
  exit 0
fi

if [ ! -d "$indoor_voice_app" ]; then
  echo "Indoor Voice.app was not found. Run npm run build:mac first." >&2
  exit 1
fi

# An ordinary ad-hoc signature gets a designated requirement containing the
# executable's hash. macOS Accessibility then treats every local rebuild as a
# different app. Pin the local development identity to the bundle identifier
# so one Accessibility grant remains valid across rebuilds.
codesign \
  --force \
  --deep \
  --sign - \
  --requirements '=designated => identifier "ai.indoorvoice.desktop"' \
  "$indoor_voice_app"

codesign --verify --deep --strict "$indoor_voice_app"
