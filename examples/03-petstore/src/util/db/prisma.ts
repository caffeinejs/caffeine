import { PrismaClient } from "@prisma/client";

// Single process-wide Prisma handle. Exported so index.ts can disconnect it on shutdown and the
// DI configuration below can hand the same instance to every repository.
export const prisma = new PrismaClient();
