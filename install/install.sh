#!/bin/sh
# Chartnaut CLI installer for macOS and Linux.
#
#   curl -fsSL https://chartnaut.com/install.sh | sh
#
# Options (environment variables):
#   CHARTNAUT_VERSION       install this version instead of the latest (e.g. 0.1.0)
#   CHARTNAUT_INSTALL       install directory root (default: ~/.chartnaut); the binary goes in $CHARTNAUT_INSTALL/bin
#   CHARTNAUT_NO_MODIFY_PATH=1   do not add the bin directory to your shell profile
#   CHARTNAUT_DOWNLOAD_URL  where latest.json lives (default: https://desktop-updates.chartnaut.com/cli)
#
# The script reads a manifest (latest.json) listing each platform's download URL and SHA-256,
# downloads the one for this machine, checks the hash, and installs a single self-contained
# executable. Nothing else is installed; Node is not needed.
set -eu

BASE="${CHARTNAUT_DOWNLOAD_URL:-https://desktop-updates.chartnaut.com/cli}"
INSTALL_ROOT="${CHARTNAUT_INSTALL:-$HOME/.chartnaut}"
BIN_DIR="$INSTALL_ROOT/bin"

if [ -t 1 ]; then
  bold="$(printf '\033[1m')"; dim="$(printf '\033[2m')"; red="$(printf '\033[31m')"; green="$(printf '\033[32m')"; reset="$(printf '\033[0m')"
else
  bold=""; dim=""; red=""; green=""; reset=""
fi

say() { printf '%s\n' "$*"; }
fail() { printf '%serror%s: %s\n' "$red" "$reset" "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || fail "this installer needs '$1'"; }

fetch() { # fetch URL [OUTFILE]
  if command -v curl >/dev/null 2>&1; then
    if [ -n "${2:-}" ]; then curl -fsSL --retry 3 -o "$2" "$1"; else curl -fsSL --retry 3 "$1"; fi
  elif command -v wget >/dev/null 2>&1; then
    if [ -n "${2:-}" ]; then wget -q -O "$2" "$1"; else wget -q -O - "$1"; fi
  else
    fail "this installer needs curl or wget"
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else fail "this installer needs sha256sum or shasum to verify the download"; fi
}

# ── which binary ──────────────────────────────────────────────────────────────────────────────
detect_platform() {
  os="$(uname -s)"; arch="$(uname -m)"
  case "$os" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    MINGW*|MSYS*|CYGWIN*) fail "on Windows, run in PowerShell: irm https://chartnaut.com/install.ps1 | iex" ;;
    *) fail "unsupported operating system: $os" ;;
  esac
  case "$arch" in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) fail "unsupported CPU architecture: $arch" ;;
  esac
  # Rosetta: an x64 shell on Apple silicon should still get the native binary.
  if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch=arm64
  fi
  suffix=""
  if [ "$os" = linux ]; then
    if [ -f /etc/alpine-release ] || (ldd --version 2>&1 | grep -qi musl); then suffix="-musl"; fi
  fi
  printf '%s-%s%s' "$os" "$arch" "$suffix"
}

PLATFORM="${CHARTNAUT_PLATFORM:-$(detect_platform)}"

# ── the manifest ──────────────────────────────────────────────────────────────────────────────
if [ -n "${CHARTNAUT_VERSION:-}" ]; then
  MANIFEST_URL="$BASE/$CHARTNAUT_VERSION/manifest.json"
else
  MANIFEST_URL="$BASE/latest.json"
fi
MANIFEST="$(fetch "$MANIFEST_URL")" || fail "could not download $MANIFEST_URL"

VERSION="$(printf '%s\n' "$MANIFEST" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
LINE="$(printf '%s\n' "$MANIFEST" | grep "\"$PLATFORM\"" | head -n 1 || true)"
[ -n "$LINE" ] || fail "no Chartnaut CLI build for $PLATFORM (version ${VERSION:-unknown})"
URL="$(printf '%s' "$LINE" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
SHA="$(printf '%s' "$LINE" | sed -n 's/.*"sha256"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p')"
[ -n "$URL" ] && [ -n "$SHA" ] || fail "the manifest entry for $PLATFORM is malformed"

say "${bold}Installing Chartnaut CLI ${VERSION}${reset} ${dim}($PLATFORM)${reset}"

# ── download, verify, install ─────────────────────────────────────────────────────────────────
TMP="$(mktemp -d 2>/dev/null || mktemp -d -t chartnaut)"
trap 'rm -rf "$TMP"' EXIT INT TERM
fetch "$URL" "$TMP/chartnaut" || fail "download failed: $URL"
GOT="$(sha256_of "$TMP/chartnaut")"
[ "$GOT" = "$SHA" ] || fail "checksum mismatch for $URL (expected $SHA, got $GOT). Nothing was installed."

chmod 755 "$TMP/chartnaut"
# Prove it runs here before it replaces anything.
"$TMP/chartnaut" --version >/dev/null 2>&1 || fail "the $PLATFORM build does not run on this machine. Nothing was installed."
mkdir -p "$BIN_DIR"
mv -f "$TMP/chartnaut" "$BIN_DIR/chartnaut"

say "${green}✓${reset} installed ${bold}$BIN_DIR/chartnaut${reset}"

# ── PATH ──────────────────────────────────────────────────────────────────────────────────────
on_path=0
case ":$PATH:" in *":$BIN_DIR:"*) on_path=1 ;; esac

if [ "$on_path" = 0 ] && [ "${CHARTNAUT_NO_MODIFY_PATH:-0}" != 1 ]; then
  shell_name="$(basename "${SHELL:-sh}")"
  case "$shell_name" in
    zsh) profile="${ZDOTDIR:-$HOME}/.zshrc"; line="export PATH=\"$BIN_DIR:\$PATH\"" ;;
    bash) if [ -f "$HOME/.bashrc" ]; then profile="$HOME/.bashrc"; else profile="$HOME/.bash_profile"; fi; line="export PATH=\"$BIN_DIR:\$PATH\"" ;;
    fish) profile="$HOME/.config/fish/config.fish"; line="fish_add_path $BIN_DIR" ;;
    *) profile="$HOME/.profile"; line="export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
  mkdir -p "$(dirname "$profile")"
  if ! grep -qs "$BIN_DIR" "$profile"; then
    printf '\n# Chartnaut CLI\n%s\n' "$line" >> "$profile"
    say "${green}✓${reset} added $BIN_DIR to PATH in $profile"
  fi
  say ""
  say "Open a new terminal, or run:  ${bold}$line${reset}"
fi

say ""
say "Next:"
say "  ${bold}chartnaut login${reset}      sign in with your browser"
say "  ${bold}chartnaut init${reset}       set up a project for Claude Code or Codex"
say "  ${bold}chartnaut --help${reset}"
