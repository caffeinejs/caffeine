import { HealthIndicator, type HealthReport, up } from "@caffeinejs/std";
import type { PrismaClient } from "@prisma/client";

/**
 * Reports whether the database is reachable, on the **readiness** probe only.
 *
 * `critical` is left at its default of `true`, so a failure takes this pod out of the Service. Understand what
 * that buys and what it costs before copying it:
 *
 * - every replica checks the *same* database, so an outage fails readiness on all of them at once, the Service's
 *   endpoint list empties, and routes that never touch the database go down with it — and no pod then receives
 *   the traffic that would demonstrate recovery;
 * - the petstore does nothing useful without its data, so reporting "ready" while every request 500s would be a
 *   lie the orchestrator cannot act on.
 *
 * For a dependency the application *can* serve without — a metrics sink, a recommendation service — set
 * `readonly critical = false`. The indicator then reports `degraded`, `/readyz` stays 200, and the pod keeps
 * taking the traffic it can still handle.
 *
 * Nothing here belongs on `/livez`. Restarting the process does not repair a database, it only removes a
 * consumer that would otherwise reconnect on its own.
 */
export class DatabaseHealth extends HealthIndicator {
  readonly name = "database";

  readonly #prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    super();
    this.#prisma = prisma;
  }

  async check(): Promise<HealthReport> {
    // The cheapest round trip that proves the connection pool can still reach the server. The probe deadline
    // bounds it, so a hung database produces a 503 rather than a hung request.
    await this.#prisma.$queryRaw`SELECT 1`;

    return up();
  }
}
