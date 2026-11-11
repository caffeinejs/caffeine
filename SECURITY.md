# Security policy

## Supported versions

Only the newest release gets security fixes. Before 1.0.0 that is the newest release candidate: a fix ships in the
next one, never in an earlier version. See [Versioning](docs/versioning.md).

## Reporting a vulnerability

Report it privately, through GitHub's
[private vulnerability reporting](https://github.com/caffeinejs/caffeine/security/advisories/new). Do not open a
public issue, pull request or discussion about it.

Include the affected package and version, what an attacker can do, and the steps or code that show it. The
conversation, the fix and the advisory stay in that private report until a release carries the fix.

## Verifying a release

Every package from `0.0.1-rc.2` on, apart from a new package's first version, is published from the release workflow
with npm provenance, which ties the tarball to the commit and workflow run that built it. In an application, check
every installed package's registry signature and provenance:

```sh
npm audit signatures
```

Each platform package of `@caffeinejs/cli` holds `sbom.cdx.json`, a CycloneDX SBOM of its binary. The same SBOMs are
attached to the release on [GitHub Releases](https://github.com/caffeinejs/caffeine/releases).

The `ghcr.io/caffeinejs/devtools-ui` image is signed with cosign, without a key, and carries a provenance
attestation:

```sh
cosign verify ghcr.io/caffeinejs/devtools-ui:0.0.1-rc.2 \
  --certificate-identity-regexp '^https://github\.com/caffeinejs/caffeine/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

gh attestation verify oci://ghcr.io/caffeinejs/devtools-ui:0.0.1-rc.2 --repo caffeinejs/caffeine
```
