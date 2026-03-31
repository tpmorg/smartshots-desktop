#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok() {
  printf "${GREEN}✓${NC} %s\n" "$1"
}

warn() {
  printf "${YELLOW}!${NC} %s\n" "$1"
}

fail() {
  printf "${RED}x${NC} %s\n" "$1"
  exit 1
}

load_env_file() {
  local env_file="$1"
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
    ok "loaded $(basename "$env_file")"
  fi
}

require_env() {
  local var_name="$1"
  if [ -z "${!var_name:-}" ]; then
    fail "missing required environment variable: $var_name"
  fi
}

if [ "$(uname -s)" != "Darwin" ]; then
  fail "macOS release builds must be run on macOS"
fi

load_env_file "$ROOT_DIR/.env.local"
load_env_file "$ROOT_DIR/.env.release.local"

require_env "VITE_SUPABASE_URL"
require_env "VITE_SUPABASE_ANON_KEY"
require_env "APPLE_SIGNING_IDENTITY"
require_env "APPLE_ID"
require_env "APPLE_PASSWORD"
require_env "APPLE_TEAM_ID"

if ! command -v security >/dev/null 2>&1; then
  fail "macOS security tool not found"
fi

if ! security find-identity -v -p codesigning | grep -F "$APPLE_SIGNING_IDENTITY" >/dev/null 2>&1; then
  fail "signing identity not found in local keychain: $APPLE_SIGNING_IDENTITY"
fi

ok "using signing identity: $APPLE_SIGNING_IDENTITY"
warn "APPLE_PASSWORD must be an app-specific password from appleid.apple.com"

npm run tauri:build

ok "macOS release build complete"
echo "Artifacts:"
echo "  $ROOT_DIR/src-tauri/target/release/bundle/dmg"
echo "  $ROOT_DIR/src-tauri/target/release/bundle/macos"
