#!/bin/sh
set -e

# Apply committed migrations (apply-only, no shadow DB), seed demo data, then start the app.
npx prisma migrate deploy
npx tsx prisma/seed.ts

# Exec the binary directly rather than through `npx`: npx runs the real command as a *child*, so SIGTERM lands on
# npx and the application's graceful shutdown never runs. `exec` replaces this shell with node itself.
#
# The path is the workspace root's, not this package's: npm hoists tsx to /app/node_modules/.bin.
exec /app/node_modules/.bin/tsx src/main.ts
