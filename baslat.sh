#!/usr/bin/env bash
set -e
if ! command -v node &> /dev/null; then
  echo "[HATA] Node.js kurulu değil! Lütfen https://nodejs.org adresinden kurun."
  exit 1
fi
(sleep 1 && (xdg-open http://localhost:3000 2>/dev/null || open http://localhost:3000 2>/dev/null || true)) &
node server.js
