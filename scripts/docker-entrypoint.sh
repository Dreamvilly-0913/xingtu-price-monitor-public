#!/bin/sh
set -eu
node /app/scripts/database.mjs push
cd /app/server
exec node dist/src/index.js
