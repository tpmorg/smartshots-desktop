#!/usr/bin/env bash
set -u

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
}

need_fix=0

echo "Smartshots Desktop doctor"
echo "-------------------------"

if command -v node >/dev/null 2>&1; then
  ok "node: $(node -v)"
else
  fail "node is not installed"
  need_fix=1
fi

if command -v npm >/dev/null 2>&1; then
  ok "npm: $(npm -v)"
else
  fail "npm is not installed"
  need_fix=1
fi

if command -v cargo >/dev/null 2>&1; then
  ok "cargo: $(cargo --version)"
else
  fail "cargo not found on PATH"
  need_fix=1
fi

if command -v rustc >/dev/null 2>&1; then
  ok "rustc: $(rustc --version)"
else
  fail "rustc not found on PATH"
  need_fix=1
fi

if command -v xcode-select >/dev/null 2>&1; then
  if xcode-select -p >/dev/null 2>&1; then
    ok "xcode command line tools: installed"
  else
    warn "xcode command line tools may not be installed"
    need_fix=1
  fi
fi

if command -v npx >/dev/null 2>&1; then
  if npx tauri --version >/dev/null 2>&1; then
    ok "tauri cli: $(npx tauri --version)"
  else
    warn "tauri cli check failed via npx"
  fi
fi

echo
if [ "$need_fix" -eq 1 ]; then
  echo "Recommended fixes (macOS):"
  echo "  xcode-select --install"
  echo "  brew install rust"
  echo '  eval "$(/opt/homebrew/bin/brew shellenv)"'
  echo "  npm install"
  echo "  npm run tauri:dev"
  exit 1
else
  ok "environment looks ready for Tauri"
  echo "Next: npm run tauri:dev"
fi
