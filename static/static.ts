import { validateHeaderName, validateHeaderValue } from 'node:http'
import { join, posix, relative } from 'node:path'

import type { HTTPPluginFactory, HTTPPluginConfigurer } from '@caffeinejs/http'

import { StaticBuilder, kBuild } from './builder.js'
import type { ResolvedMount } from './config.js'
import { ErrStaticScanInProduction } from './errors.js'
import { prepareAssets, prepareMount, policyOf, StaticFiles } from './http/http.js'
import type { ManifestFile, StaticManifest } from './manifest/manifest.js'
import { readManifest } from './manifest/read.js'
import { readFileEntry, scan } from './scan/scan.js'
import { openFile, prepareFile, rootOnDisk, verifyHashes } from './serve.js'

/** Authors static file serving through {@link StaticBuilder}. */
export type StaticConfigurer<C = unknown> = HTTPPluginConfigurer<StaticBuilder, C>

/**
 * Serves static files from a manifest, as a plugin: `.with(staticFiles(s => s.serve(root)))`.
 *
 * Each mount reads `static.manifest.json`, which `buildStatic()` from `@caffeinejs/static/build` writes, and serves
 * the files it lists and nothing else, every header computed at start-up: a request reads no file system metadata.
 * A file at the mount's root is a route of its own, and each directory under it is one route answering from the
 * files it lists, so a miss under a directory is a `404` and a miss elsewhere falls through to the application's
 * routes. Compressed variants are negotiated by `Accept-Encoding` and are never URLs of their own.
 *
 * Start-up fails loudly: a missing or stale manifest, a listed file that is not there, two files answering one URL,
 * and another route answering a file's URL each name the file and the fix. The collision check probes that URL
 * without request constraints. A version, host or custom constraint can select a different route for a request.
 * On a case-insensitive router, a case-sensitive parameter regex can select a different route for another spelling
 * of the URL. Install it once per server, on the application or a listener; a router, a controller and a server with a
 * matcher of its own are refused. One `staticFiles(...)` takes several `.serve(...)` calls.
 */
export function staticFiles<C = unknown>(configure?: StaticConfigurer<C>): HTTPPluginFactory<C> {
  return async context => {
    const builder = new StaticBuilder()
    configure?.(builder, context)
    const { mounts, allowProduction } = builder[kBuild]()
    const prepared = await Promise.all(mounts.map(mount => prepare(mount, allowProduction)))

    for (const mount of prepared) {
      if (mount.mode === 'scan') {
        context.logger.warn(
          { root: mount.root },
          allowProduction && isProduction()
            ? 'Static files are served in scan mode in production'
            : 'Static files are served in scan mode: a snapshot taken at start-up, without compressed variants',
        )
      }
    }

    return new StaticFiles(prepared, context.logger)
  }
}

async function prepare(mount: ResolvedMount, allowProduction: boolean) {
  if ('assets' in mount) {
    return prepareAssets(mount.assets, mount.options)
  }

  const { root, options } = mount
  const mode = options.mode ?? 'manifest'
  if (mode === 'scan' && isProduction() && !allowProduction) {
    throw new ErrStaticScanInProduction(root)
  }

  const policy = policyOf(root, options, posix.matchesGlob, (name, value) => {
    validateHeaderName(name)
    validateHeaderValue(name, value)
  })
  const manifest = mode === 'scan' ? await scanned(root) : await readManifest(root)
  const disk = rootOnDisk(root)
  const prepared = Object.entries(manifest.files).map(([path, entry]) => prepareFile(disk, path, entry, policy))

  if (mode === 'manifest') {
    for (const file of prepared) {
      await verifyHashes(root, file, manifest.files[file.path]!)
    }
  }

  return prepareMount(
    {
      root,
      mode,
      describe: path => relative(process.cwd(), join(root, path)).split('\\').join('/'),
    },
    options,
    prepared,
    async (representation, range, ctx, log) => {
      const body = await openFile(
        representation,
        { log, reqId: ctx.req.id },
        range?.start,
        range && range.endExclusive - 1,
      )
      return {
        body,
        close: () => {
          body.destroy()
        },
      }
    },
    posix.matchesGlob,
  )
}

/** The manifest a scan of `root` makes, every file hashed and none with variants. */
async function scanned(root: string): Promise<StaticManifest> {
  const { files } = await scan(root)
  // Keyed by the site's paths, "__proto__" among them.
  const entries: Record<string, ManifestFile> = Object.create(null)

  // One file at a time, as the build reads them: a tree of thousands would otherwise open them all at once.
  for (const file of files) {
    entries[file.path] = await readFileEntry(root, file.path, file.type)
  }

  return { version: 1, files: entries }
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}
