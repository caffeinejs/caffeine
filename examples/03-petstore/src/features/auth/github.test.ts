import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { WebApplication } from "@caffeinejs/http";
import { newTestContainer } from "@caffeinejs/testing";
import { createContainer } from "../../app.container.js";
import { buildApp } from "../../app.js";
import {
  GITHUB_STATE_COOKIE,
  NAVIGATION,
  sessionHeader,
  setCookie,
  signInWithGithub,
  stubGithub,
} from "../../util/testing/github.js";

const DOCS_AUTH = `Basic ${Buffer.from("admin:admin123").toString("base64")}`;

// Exercises the two authentication schemes wired in app.ts: Basic for the API documentation, and the GitHub
// OAuth browser login that is the application default. No network and no database — GitHub is stubbed, and
// /me only reads the principal. GitHub credentials fall back to dev placeholders when the env vars are unset.
describe("authentication wiring", () => {
  let app: WebApplication;

  beforeAll(async () => {
    app = buildApp(newTestContainer(await createContainer()).build(), {
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves an HTML homepage", async () => {
    const res = await app.fetch("/");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("Sign in with GitHub");
    expect(html).toContain('href="/login/github"');
  });

  it("starts the GitHub OAuth flow: /login/github redirects to GitHub with a state cookie", async () => {
    const res = await app.fetch("/login/github", { headers: NAVIGATION });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("https://github.com/login/oauth/authorize");
    expect(location).toContain("client_id=");
    expect(location).toContain("state=");
    // Named per flow, so concurrent sign-ins do not overwrite one another's state.
    const state = new URL(location).searchParams.get("state")!;
    expect(setCookie(res, `petstore_gh_state.${state}`)).toBeTruthy();
  });

  it("completes the flow: login → callback → session cookie → authenticated /me", async () => {
    stubGithub();

    // 1. Initiate: capture the state parameter and its sealed cookie from the real challenge. The cookie
    // is named after this flow's own state, so two sign-ins in flight cannot clobber each other.
    const login = await app.fetch("/login/github", { headers: NAVIGATION });
    const state = new URL(login.headers.get("location")!).searchParams.get(
      "state",
    )!;
    const stateCookieName = `${GITHUB_STATE_COOKIE}.${state}`;
    const stateCookie = setCookie(login, stateCookieName);
    expect(state).toBeTruthy();
    expect(stateCookie).toBeTruthy();

    // 2. Callback: GitHub redirects back with the code + matching state; the handler exchanges the
    // code (stubbed), reads the user, and writes the session cookie.
    const callback = await app.fetch(
      `/login/github/callback?code=fake-code&state=${state}`,
      {
        headers: { cookie: `${stateCookieName}=${stateCookie}` },
      },
    );
    expect(callback.status).toBe(302);
    const sessionCookie = setCookie(callback, "petstore_gh_session");
    expect(sessionCookie).toBeTruthy();
    // The sealed session must fit in a single cookie; a browser silently drops one over ~4096 bytes,
    // which is what caused the post-login redirect loop when every GitHub field was sealed.
    expect(sessionCookie.length).toBeLessThan(4096);

    // 3. The session cookie authenticates /me under the GitHub scheme.
    const me = await app.fetch("/me", {
      headers: { cookie: `petstore_gh_session=${sessionCookie}` },
    });
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      authenticated: boolean;
      sub: unknown;
      name: unknown;
    };
    expect(body.authenticated).toBe(true);
    expect(body.sub).toBe(4242);
    expect(body.name).toBe("The Octocat");

    // 4. Re-hitting /login/github while signed in must redirect to the dashboard, not re-challenge
    // GitHub — otherwise the post-callback return to this route loops forever.
    const relogin = await app.fetch("/login/github", {
      headers: { cookie: `petstore_gh_session=${sessionCookie}` },
    });
    expect(relogin.status).toBe(302);
    expect(relogin.headers.get("location")).toBe("/dashboard");
    expect(relogin.headers.get("location")).not.toContain("github.com");

    // 5. The dashboard renders the signed-in identity as HTML.
    const dash = await app.fetch("/dashboard", {
      headers: { cookie: `petstore_gh_session=${sessionCookie}` },
    });
    expect(dash.status).toBe(200);
    expect(dash.headers.get("content-type")).toContain("text/html");
    const dashHtml = await dash.text();
    expect(dashHtml).toContain("The Octocat");
    expect(dashHtml).toContain("/logout");

    // 6. Logout clears the session cookie and returns home.
    const logout = await app.fetch("/logout", {
      headers: { cookie: `petstore_gh_session=${sessionCookie}` },
    });
    expect(logout.status).toBe(302);
    expect(logout.headers.get("location")).toBe("/");
    expect(setCookie(logout, "petstore_gh_session")).toBe("");
  });

  // GitHub is the default scheme now, so an unauthenticated request to a guarded route is challenged into
  // the OAuth flow rather than answered a bare 401. That is the browser-first behaviour this example wants;
  // the documentation routes below are the deliberate exception.
  it("redirects an anonymous /dashboard into the GitHub flow", async () => {
    const res = await app.fetch("/dashboard", { headers: NAVIGATION });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      "github.com/login/oauth/authorize",
    );
  });

  it("redirects an anonymous /me into the GitHub flow", async () => {
    const res = await app.fetch("/me", { headers: NAVIGATION });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(
      "github.com/login/oauth/authorize",
    );
  });

  // A redirect to github.com is something only a browser navigation can follow: `fetch` follows it itself,
  // lands cross-origin on a host that sends no CORS headers, and the caller sees a network error instead of
  // "you are not signed in". So an API caller gets a 401 naming the same URL — which is also what makes the
  // documentation UI's "Try it" show a readable failure rather than a CORS wall.
  it("answers an API caller 401, with the authorization URL in location", async () => {
    const res = await app.fetch("/me", {
      headers: { accept: "application/json" },
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toContain(
      "github.com/login/oauth/authorize",
    );
  });

  it("authenticates /me with a GitHub session", async () => {
    stubGithub();
    const session = await signInWithGithub(app);

    const res = await app.fetch("/me", { headers: sessionHeader(session) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      authenticated: boolean;
      sub: unknown;
      name: unknown;
    };
    expect(body.authenticated).toBe(true);
    expect(body.sub).toBe(4242);
    expect(body.name).toBe("The Octocat");
  });
});

// The documentation is the one part of the application that names a scheme. These assertions are what make
// that meaningful: Basic is demanded, and — critically — a valid GitHub session does not substitute for it.
describe("documentation is protected by Basic, independently of the default scheme", () => {
  let app: WebApplication;

  beforeAll(async () => {
    app = buildApp(newTestContainer(await createContainer()).build(), {
      logger: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("challenges as Basic, not by redirecting to GitHub", async () => {
    const res = await app.fetch("/openapi.json");

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
    expect(res.headers.get("location")).toBeNull();
  });

  it("serves the document to a valid Basic credential", async () => {
    const res = await app.fetch("/openapi.json", {
      headers: { authorization: DOCS_AUTH },
    });

    expect(res.status).toBe(200);
  });

  it("rejects wrong Basic credentials", async () => {
    const wrong = `Basic ${Buffer.from("admin:nope").toString("base64")}`;

    expect(
      (await app.fetch("/openapi.json", { headers: { authorization: wrong } }))
        .status,
    ).toBe(401);
  });

  // The downgrade case. A signed-in GitHub user is authenticated as far as the default scheme is concerned,
  // but the documentation accepts Basic and only Basic — so this must still be refused.
  it("does not accept a GitHub session in place of Basic", async () => {
    stubGithub();
    const session = await signInWithGithub(app);

    // The same session does authenticate a route that runs on the default scheme.
    expect(
      (await app.fetch("/me", { headers: sessionHeader(session) })).status,
    ).toBe(200);

    const docs = await app.fetch("/openapi.json", {
      headers: sessionHeader(session),
    });

    expect(docs.status).toBe(401);
    expect(docs.headers.get("www-authenticate")).toContain("Basic");
  });
});
