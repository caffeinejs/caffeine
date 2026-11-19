# @caffeinejs/static

Static file serving for a CaffeineJS HTTP application, a single-page application included.

```sh
npm install -E @caffeinejs/static
```

Install every `@caffeinejs/*` package at the same exact version: [Versioning](https://github.com/caffeinejs/caffeine/blob/main/docs/versioning.md).

## Verify a staged release

After the frontend build finishes, run the finalizer on its output. Before publishing, verify the directory that will actually be deployed.

```ts
import { buildStatic, verifyStatic } from '@caffeinejs/static/build'

await buildStatic({ root: 'web/dist' })
const { files, variants, bytes } = await verifyStatic({ root: 'staged/web' })
```

`verifyStatic` reads the release without modifying it. It checks each stored object's length and SHA-256, then checks that each gzip or Brotli representation decodes to its identity's length and SHA-256. Its byte count includes the stored variants. A failure rejects with `ErrStaticManifest` and identifies the failing object. Install `@caffeinejs/cli` as a development dependency to run the same operations from a build tool. The command loads the selected project's `@caffeinejs/static/build` implementation.

```sh
caffeine static build --root web/dist
caffeine static verify --root staged/web
```

Use `--cwd PROJECT` to select another project. A relative `--root` resolves from that directory.
Build reports the uncompressed bytes. Verify reports all stored bytes checked, including compressed variants.

## Verify a source with Web Streams

Use `@caffeinejs/static/web` to verify an immutable release from a worker, Node or Bun. The example binds a directory on Node or Bun. An object-store implementation can supply the same two methods in a worker.

```ts
import { directorySource } from '@caffeinejs/static/directory'
import { verifyStaticAssets } from '@caffeinejs/static/web'
import { Second } from '@caffeinejs/std/duration'

const source = directorySource('releases/site-v42')
const release = await verifyStaticAssets(source, { signal: AbortSignal.timeout(30 * Second) })
if (release.has('index.html')) {
  console.log(release.files, release.variants, release.bytes)
}
```

A `StaticAssetSource` binds one release version. `readManifest(signal?)` opens its UTF-8 v1 manifest. `open(key, { signal, range })` opens the raw stored bytes for a release-relative key. Each call returns a fresh, unlocked `ReadableStream<Uint8Array>` in a promise. With a range, return bytes from `start` inclusive to `endExclusive` exclusive. Preserve compressed bytes exactly as stored. Honor cancellation during acquisition and reading, and release the underlying resource on cancellation, error or EOF.

The verifier reads one object at a time, checks stored lengths and SHA-256 digests and exposes exact identity-key membership only after every representation passes. A shared representation counts once per manifest reference. The default limits are 8 MiB of manifest text and 20,000 identity keys. Set `maxManifestSize` (in bytes) and `maxEntries` on either verifier when qualifying a larger release. An aborted verification rejects with the signal's reason.

Use a trusted manifest and keep its backing release immutable for the lifetime of the source. Verification compares content to that manifest. The directory provider binds the release's real path when created. Publish updates under a new version and construct a new source for it.

## License

[MIT](LICENSE)
