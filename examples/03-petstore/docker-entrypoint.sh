#!/bin/sh
set -e

# Apply committed migrations (apply-only, no shadow DB), seed demo data, then start the app.
npx prisma migrate deploy
npx tsx prisma/seed.ts
exec npx tsx src/main.ts
