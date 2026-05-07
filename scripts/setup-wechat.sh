#!/usr/bin/env bash
# setup-wechat.sh — Extract the WeChat SQLCipher key and write it to .env
# Run from the project root: npm run setup:wechat
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXTRACTOR="$SCRIPT_DIR/wechat-key-extract"
SRC="$SCRIPT_DIR/wechat-key-extract.c"
ENV_FILE="$PROJECT_DIR/.env"

echo "=== KhipuChat WeChat Key Setup ==="
echo ""

# ── 1. Locate message_0.db ────────────────────────────────────────────────────
XWECHAT_FILES="$HOME/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files"

if [ ! -d "$XWECHAT_FILES" ]; then
  echo "ERROR: WeChat for Mac is not installed or has not been launched yet."
  echo "Install WeChat from the App Store or https://mac.weixin.qq.com/ then log in."
  exit 1
fi

# Find a user directory (wxid_*_* pattern)

# USER_DIR=""
# for d in "$XWECHAT_FILES"/wxid_*; do
#   if [ -d "$d" ]; then USER_DIR="$d"; break; fi
# done

# Instead of wxid_*, look for directories containing 'db_storage'
USER_DIR=$(find "$XWECHAT_FILES" -maxdepth 2 -name "db_storage" -print -quit | sed 's/\/db_storage//')

if [ -z "$USER_DIR" ]; then
  echo "ERROR: No WeChat user directory found. Log in to WeChat first."
  exit 1
fi

DB_FILE="$USER_DIR/db_storage/message/message_0.db"
if [ ! -f "$DB_FILE" ]; then
  echo "ERROR: message_0.db not found at: $DB_FILE"
  echo "Log in to WeChat first so the databases are created."
  exit 1
fi

echo "Found WeChat user directory: $(basename "$USER_DIR")"
echo "Database: $DB_FILE"
echo ""

# ── 2. Check if WeChat is running ─────────────────────────────────────────────
WECHAT_PID=$(pgrep -x WeChat 2>/dev/null || true)
if [ -z "$WECHAT_PID" ]; then
  echo "ERROR: WeChat is not running. Start WeChat and log in, then re-run this script."
  exit 1
fi
echo "WeChat PID: $WECHAT_PID"

# ── 3. Compile the key extractor ─────────────────────────────────────────────
if [ ! -f "$EXTRACTOR" ] || [ "$SRC" -nt "$EXTRACTOR" ]; then
  echo "Compiling key extractor..."
  cc -O2 -arch arm64 -arch x86_64 -o "$EXTRACTOR" "$SRC" \
    -framework Security -framework CoreFoundation 2>/dev/null || \
  cc -O2 -arch arm64 -arch x86_64 -o "$EXTRACTOR" "$SRC" \
    -framework CoreFoundation
  echo "Compiled: $EXTRACTOR"
fi

# ── 4. Try to extract the key (may fail if WeChat has hardened runtime) ────────
echo ""
echo "Attempting to read WeChat process memory (requires sudo)..."
KEY_LINE=$(sudo "$EXTRACTOR" "$WECHAT_PID" "$DB_FILE" 2>/tmp/wechat_key_err.txt || true)

if [ -z "$KEY_LINE" ]; then
  ERR=$(cat /tmp/wechat_key_err.txt 2>/dev/null)

  if echo "$ERR" | grep -q "task_for_pid failed"; then
    echo ""
    echo "Memory access denied — WeChat has a hardened runtime."
    echo ""
    echo "To allow key extraction, WeChat must be ad-hoc re-signed."
    echo "This removes the hardened runtime entitlement from WeChat."
    echo ""
    echo -n "Re-sign WeChat now? This requires sudo and will restart WeChat. [y/N] "
    read -r ANSWER
    if [ "$ANSWER" != "y" ] && [ "$ANSWER" != "Y" ]; then
      echo ""
      echo "Aborted. Set WECHAT_DB_KEY manually in .env once you have the key."
      exit 1
    fi

    echo ""
    echo "Re-signing WeChat (requires sudo)..."
    sudo codesign --force --deep --sign - /Applications/WeChat.app
    echo "Done. Restarting WeChat..."
    osascript -e 'quit app "WeChat"' 2>/dev/null || true
    sleep 2
    open /Applications/WeChat.app
    echo ""
    echo "Please log in to WeChat, then press ENTER to continue..."
    read -r _

    WECHAT_PID=$(pgrep -x WeChat 2>/dev/null || true)
    if [ -z "$WECHAT_PID" ]; then
      echo "ERROR: WeChat is not running after restart."
      exit 1
    fi
    echo "WeChat PID: $WECHAT_PID"

    echo "Extracting key from memory (sudo)..."
    KEY_LINE=$(sudo "$EXTRACTOR" "$WECHAT_PID" "$DB_FILE" 2>/tmp/wechat_key_err.txt || true)
  fi
fi

# Second attempt with sudo if still empty (task_for_pid needs root on macOS 12+)
if [ -z "$KEY_LINE" ]; then
  ERR=$(cat /tmp/wechat_key_err.txt 2>/dev/null)
  if echo "$ERR" | grep -q "task_for_pid failed"; then
    echo "Retrying with sudo (task_for_pid requires root on macOS 12+)..."
    KEY_LINE=$(sudo "$EXTRACTOR" "$WECHAT_PID" "$DB_FILE" 2>/tmp/wechat_key_err.txt || true)
  fi
fi

if [ -z "$KEY_LINE" ]; then
  echo ""
  echo "ERROR: Could not extract key."
  cat /tmp/wechat_key_err.txt 2>/dev/null
  echo ""
  echo "Make sure you are logged in to WeChat and have active chats."
  exit 1
fi

# KEY_LINE = "WECHAT_DB_KEY=<64-hex-chars>"
HEX_KEY="${KEY_LINE#WECHAT_DB_KEY=}"
echo ""
echo "Key extracted successfully: ${HEX_KEY:0:8}...${HEX_KEY: -8}"

# ── 5. Write to .env ──────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  touch "$ENV_FILE"
fi

if grep -q "^WECHAT_DB_KEY=" "$ENV_FILE" 2>/dev/null; then
  # Update existing line
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s|^WECHAT_DB_KEY=.*|WECHAT_DB_KEY=$HEX_KEY|" "$ENV_FILE"
  else
    sed -i "s|^WECHAT_DB_KEY=.*|WECHAT_DB_KEY=$HEX_KEY|" "$ENV_FILE"
  fi
  echo "Updated WECHAT_DB_KEY in .env"
else
  echo "WECHAT_DB_KEY=$HEX_KEY" >> "$ENV_FILE"
  echo "Added WECHAT_DB_KEY to .env"
fi

echo ""
echo "Setup complete. Run 'npm run sync:wechat' to sync your WeChat messages."
