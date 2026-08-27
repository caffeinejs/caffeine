import {
  AllowAnonymous,
  AuthenticationService,
  Authorize,
  type Context,
  Controller,
  Get,
  Params,
  $p,
} from "@caffeinejs/http";
import { APIGroup } from "@caffeinejs/openapi";
import { View } from "@caffeinejs/view";

// GitHub OAuth sign-in. The callback route (/login/github/callback) is registered automatically by
// the framework's OIDCConfigurer from the configured callbackURL — only the initiation route lives
// here.
//
// Hidden from the OpenAPI document: these are browser redirects and rendered pages, not API operations. The
// GitHub scheme itself still appears under components.securitySchemes, derived from .authentication(...).
@APIGroup({ hidden: true })
@Controller("/", [AuthenticationService])
export class GithubAuthController {
  constructor(private readonly auth: AuthenticationService) {}

  // Starts the flow explicitly: the challenge builds GitHub's authorize URL, sets the sealed state
  // cookie, and 302-redirects. Anonymous so the authz guard does not challenge first — the
  // default scheme only redirects to GitHub once a session cookie exists.
  //
  // Already-signed-in requests must NOT re-challenge: the callback redirects back to the URL that
  // started the flow (this route), so a blind challenge here loops forever. Send them to the
  // dashboard instead — which is also the landing page after a fresh sign-in.
  @Get("/login/github")
  @AllowAnonymous()
  @Params([$p.context()])
  async login(ctx: Context) {
    if (ctx.user.authenticated) {
      ctx.redirect("/dashboard");
      return;
    }
    await this.auth.challenge(ctx, "GitHub");
  }

  // Post-login landing page: a small HTML profile of whoever is signed in.
  // Rendered from src/views/dashboard.hbs; Handlebars auto-escapes the model, so no manual escaping.
  @Get("/dashboard")
  @Authorize()
  @Params([$p.context()])
  dashboard(ctx: Context) {
    const user = ctx.user;
    const name =
      user.findFirst("name")?.value ??
      user.findFirst("login")?.value ??
      "there";
    const sub = user.findFirst("sub")?.value;
    const email = user.findFirst("email")?.value;
    const avatarRaw = user.findFirst("avatar_url")?.value;
    // Only render a plain https image URL — never inject an arbitrary attacker-influenced string as a src.
    const avatar =
      typeof avatarRaw === "string" && avatarRaw.startsWith("https://")
        ? avatarRaw
        : undefined;
    const authType =
      user.identities.map((i) => i.authenticationType).join(", ") || "unknown";
    const roles = user
      .findAll("roles")
      .flatMap((c) => (Array.isArray(c.value) ? c.value : [c.value]));

    const rows = [
      { label: "Subject", value: sub ?? "—" },
      { label: "Email", value: email ?? "—" },
      { label: "Signed in via", value: authType },
      { label: "Roles", value: roles.length ? roles.join(", ") : "—" },
    ];

    return View("dashboard", {
      name,
      avatar,
      rows,
      title: "Petstore — Signed in",
    });
  }

  // Clears the GitHub session cookie and returns home. Anonymous so signing out never 401s.
  @Get("/logout")
  @AllowAnonymous()
  @Params([$p.context()])
  async logout(ctx: Context) {
    await this.auth.revoke(ctx, "GitHub");
    ctx.redirect("/");
  }

  // Machine-readable principal for API clients. Accepts either scheme.
  @Get("/me")
  @Authorize()
  @Params([$p.context()])
  me(ctx: Context) {
    const user = ctx.user;
    return {
      authenticated: user.authenticated,
      authenticationType: user.identities.map((i) => i.authenticationType),
      sub: user.findFirst("sub")?.value,
      name: user.findFirst("name")?.value ?? user.findFirst("login")?.value,
      email: user.findFirst("email")?.value,
      roles: user
        .findAll("roles")
        .flatMap((c) => (Array.isArray(c.value) ? c.value : [c.value])),
    };
  }
}
