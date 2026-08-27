import "dotenv/config";
import { createContainer } from "./app.container.js";
import { buildApp } from "./app.js";
import { prisma } from "./util/db/index.js";

const app = buildApp(createContainer());

// Closing the pool belongs after the drain, not before it: `application:pre-shutdown` runs once readiness has
// already been refusing for the drain delay, so no in-flight request loses its connection mid-query.
app.on("application:pre-shutdown", () => prisma.$disconnect());

// No signal handling here. `.health()` installs SIGTERM/SIGINT, refuses readiness, waits out the routing-table
// lag while still serving, closes the server, and lets the process exit on its own — calling process.exit()
// straight after close() would truncate the very logs describing the shutdown.
await app.run();
