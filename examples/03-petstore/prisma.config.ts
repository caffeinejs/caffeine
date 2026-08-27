import "dotenv/config";
import path from "node:path";
import { defineConfig } from "prisma/config";

// A prisma.config.ts disables Prisma's automatic .env loading, so load it explicitly here to
// keep DATABASE_URL available for db:migrate* and db:seed. `prisma generate` does not need it.
export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
