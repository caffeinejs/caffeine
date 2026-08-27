import { afterEach, describe, expect, it } from "vitest";
import { HealthIndicator, type HealthReport, down, up } from "@caffeinejs/std";
import type { WebApplication } from "@caffeinejs/http";
import { newTestContainer } from "@caffeinejs/testing";
import { createContainer } from "../../app.container.js";
import { buildApp } from "../../app.js";

// Ephemeral port: the probes only answer once `run()` has started listening, and the configured default (9999)
// would collide with anything else on the machine.
process.env.PETSTORE_SERVER__PORT = "0";

class FakeDatabaseHealth extends HealthIndicator {
  readonly name = "database";

  constructor(private readonly healthy: boolean) {
    super();
  }

  check(): HealthReport {
    return this.healthy ? up() : down("connection refused");
  }
}

async function start(indicators: HealthIndicator[]): Promise<WebApplication> {
  const app = buildApp(
    newTestContainer(createContainer()).build(),
    { logger: false },
    indicators,
  );
  await app.run();
  return app;
}

const probe = (app: WebApplication, url: string) =>
  app.instance.inject({ method: "GET", url });

describe("health probes", () => {
  let app: WebApplication | undefined;

  afterEach(async () => {
    if (app !== undefined) {
      await app.close();
      app = undefined;
    }
  });

  it("reports ready once the database answers", async () => {
    app = await start([new FakeDatabaseHealth(true)]);

    expect((await probe(app, "/readyz")).statusCode).toBe(200);
    expect((await probe(app, "/livez")).statusCode).toBe(200);
    expect((await probe(app, "/startupz")).statusCode).toBe(200);
  });

  it("fails readiness but never liveness when the database is unreachable", async () => {
    app = await start([new FakeDatabaseHealth(false)]);

    expect((await probe(app, "/readyz")).statusCode).toBe(503);
    // The pod must not be restarted because Postgres blinked — restarting repairs nothing.
    expect((await probe(app, "/livez")).statusCode).toBe(200);
    expect((await probe(app, "/startupz")).statusCode).toBe(200);
  });

  it("refuses readiness as soon as shutdown begins, without touching the database", async () => {
    let checks = 0;
    const indicator = new (class extends HealthIndicator {
      readonly name = "database";
      check(): HealthReport {
        checks++;
        return up();
      }
    })();

    const started = await start([indicator]);
    const before = checks;

    const closing = started.close();

    expect((await probe(started, "/readyz")).statusCode).toBe(503);
    // A draining pod answers from its own state; hammering the database on the way out helps nobody.
    expect(checks).toBe(before);

    await closing;
  });

  it("leaves the probes reachable without authentication", async () => {
    app = await start([]);

    // Every other route in this application sits behind an authentication scheme.
    expect((await probe(app, "/readyz")).statusCode).toBe(200);
    expect((await probe(app, "/api/v1/pets")).statusCode).not.toBe(200);
  });
});
