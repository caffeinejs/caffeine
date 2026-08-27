import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYAML } from "yaml";
import type { WebApplication } from "@caffeinejs/http";
import type { OpenAPIDocument, OperationObject } from "@caffeinejs/openapi";
import { newTestContainer } from "@caffeinejs/testing";
import { createContainer } from "./app.container.js";
import { buildApp } from "./app.js";

// The documentation is Basic-protected — the one place in this application that names a scheme.
const DOCS_AUTH = `Basic ${Buffer.from("admin:admin123").toString("base64")}`;

const specPath = fileURLToPath(
  new URL("../spec/openapi.petstore.yaml", import.meta.url),
);

let app: WebApplication;
let document: OpenAPIDocument;

function operation(path: string, method: string): OperationObject | undefined {
  const item = document.paths?.[path] as
    | Record<string, OperationObject>
    | undefined;
  return item?.[method];
}

/** Every operationId in the generated document, including 3.2's additionalOperations. */
function operationIds(): string[] {
  const ids: string[] = [];

  for (const item of Object.values(document.paths ?? {})) {
    const fixed = Object.entries(item)
      .filter(([key]) =>
        [
          "get",
          "put",
          "post",
          "delete",
          "options",
          "head",
          "patch",
          "trace",
        ].includes(key),
      )
      .map(([, value]) => value as OperationObject);

    for (const op of [
      ...fixed,
      ...Object.values(item.additionalOperations ?? {}),
    ]) {
      if (op.operationId !== undefined) {
        ids.push(op.operationId);
      }
    }
  }

  return ids.sort();
}

beforeAll(async () => {
  app = buildApp(newTestContainer(createContainer()).build(), {
    logger: false,
  });
  await app.ready();

  const res = await app.fetch("/openapi.json", {
    headers: { authorization: DOCS_AUTH },
  });
  expect(res.status).toBe(200);
  document = (await res.json()) as OpenAPIDocument;
});

afterAll(async () => {
  await app?.close();
});

describe("the generated OpenAPI document", () => {
  it("is a 3.2.0 document with the configured info", () => {
    expect(document.openapi).toBe("3.2.0");
    expect(document.info.title).toBe("Modern Petstore");
    // Relative, so it is correct at whatever host and port the app was reached on — and so the docs UI's
    // "Try it" stays same-origin, which is what lets the browser attach the GitHub session cookie.
    expect(document.servers?.[0].url).toBe("/");
  });

  // The README used to carry this table by hand. The generator owns it now, and the checked-in spec the
  // example is modelled on is what it is checked against — so a route added without an @Operation, or one
  // whose id drifts from the specification, fails here rather than in someone's client generator.
  it("implements exactly the operations the checked-in specification names", () => {
    const spec = parseYAML(readFileSync(specPath, "utf8")) as OpenAPIDocument;

    const specified = new Set<string>();
    for (const item of Object.values(spec.paths ?? {})) {
      for (const [key, value] of Object.entries(item)) {
        if (["get", "put", "post", "delete", "patch", "query"].includes(key)) {
          const id = (value as OperationObject).operationId;
          if (id !== undefined) {
            specified.add(id);
          }
        }
      }
    }

    for (const id of operationIds()) {
      expect(
        specified,
        `"${id}" is not an operationId in spec/openapi.petstore.yaml`,
      ).toContain(id);
    }

    expect(operationIds()).toEqual([
      "createOrder",
      "createPet",
      "createUser",
      "deleteOrder",
      "deletePet",
      "deleteUser",
      "getInventory",
      "getOrder",
      "getPet",
      "getUserById",
      "listPets",
      "searchPets",
      "updatePet",
      "updateUser",
      "uploadPetPhoto",
    ]);
  });

  it("groups operations under the controllers' tags", () => {
    expect(document.tags?.map((t) => t.name).sort()).toEqual([
      "Inventory",
      "Orders",
      "Pets",
      "Users",
    ]);
    expect(operation("/pets", "get")?.tags).toEqual(["Pets"]);
  });

  it("omits the browser-facing pages and its own endpoints", () => {
    const paths = Object.keys(document.paths ?? {});

    expect(paths).not.toContain("/");
    expect(paths).not.toContain("/login/github");
    expect(paths).not.toContain("/dashboard");
    expect(paths).not.toContain("/openapi.json");
    expect(paths).not.toContain("/docs");
  });

  it("hoists the shared schemas into components", () => {
    const names = Object.keys(document.components?.schemas ?? {});

    expect(names).toEqual(
      expect.arrayContaining(["ApiError", "Order", "Pet", "PetList", "User"]),
    );
    expect(
      operation("/pets/{id}", "get")?.responses?.["200"].content?.[
        "application/json"
      ].schema,
    ).toEqual({ $ref: "#/components/schemas/Pet" });
  });

  it("never advertises the write-only password on a user response", () => {
    const user = document.components?.schemas?.User;
    expect(Object.keys((user?.properties ?? {}) as object)).not.toContain(
      "password",
    );
  });

  it("derives the security schemes from the authentication configuration", () => {
    const schemes = document.components?.securitySchemes ?? {};

    expect(Object.keys(schemes).sort()).toEqual(["Basic", "GitHub"]);
    expect(schemes.Basic).toEqual({ type: "http", scheme: "basic" });

    // A cookie, not an OAuth2 bearer flow: the GitHub strategy authenticates from the sealed session cookie
    // and never reads an Authorization header. Documenting it as `oauth2` would tell a client to obtain a
    // token the server ignores — and send a documentation UI into a browser token exchange GitHub refuses
    // cross-origin. The sign-in survives as prose, since `apiKey` has nowhere structured to put it.
    expect(schemes.GitHub).toMatchObject({
      type: "apiKey",
      in: "cookie",
      name: "petstore_gh_session",
    });
    expect((schemes.GitHub as { description?: string }).description).toContain(
      "https://github.com/login/oauth/authorize",
    );
  });

  it("marks the guarded routes guarded and the public ones public", () => {
    // An empty requirement is the specification's "no security", which is what @AllowAnonymous means.
    expect(operation("/pets", "get")?.security).toEqual([]);

    // No controller names a scheme, so a guarded route documents the application default. The scope list is
    // empty because an apiKey scheme has no scope concept — `write:pets` is stated in the description below.
    expect(operation("/pets", "post")?.security).toEqual([{ GitHub: [] }]);

    // Roles are still stated in prose, because most scheme types cannot carry them.
    expect(operation("/pets", "post")?.description).toContain("write:pets");
  });

  it("never references a security scheme that components does not define", () => {
    const defined = new Set(
      Object.keys(document.components?.securitySchemes ?? {}),
    );

    for (const item of Object.values(document.paths ?? {})) {
      for (const op of Object.values(item) as OperationObject[]) {
        for (const requirement of op?.security ?? []) {
          for (const name of Object.keys(requirement)) {
            expect(
              defined,
              `"${name}" is referenced but not defined`,
            ).toContain(name);
          }
        }
      }
    }
  });

  it("documents the validation status the error handler actually answers", () => {
    // The fallback handler maps a body validation failure to 422, not Fastify's default 400.
    const statuses = Object.keys(operation("/pets", "post")?.responses ?? {});

    expect(statuses).toContain("422");
    expect(statuses).not.toContain("400");
  });

  it("describes the multipart upload without anyone writing it down", () => {
    const body = operation("/pets/{id}/images", "post")?.requestBody;

    expect(body?.content["multipart/form-data"].schema).toMatchObject({
      properties: { file: { type: "string", format: "binary" } },
    });
  });

  it("represents the QUERY verb, which 3.2 added and 3.1 cannot express", () => {
    expect(
      document.paths?.["/pets"].additionalOperations?.QUERY?.operationId,
    ).toBe("searchPets");
  });

  it("turns a uuid path parameter into a typed, required parameter", () => {
    const id = operation("/pets/{id}", "get")?.parameters?.find(
      (p) => p.name === "id",
    );

    expect(id).toMatchObject({
      in: "path",
      required: true,
      schema: { format: "uuid" },
    });
  });

  it("serves the same document as YAML", async () => {
    const res = await app.fetch("/openapi.yaml", {
      headers: { authorization: DOCS_AUTH },
    });

    expect(res.status).toBe(200);
    expect(parseYAML(await res.text())).toEqual(document);
  });
});
