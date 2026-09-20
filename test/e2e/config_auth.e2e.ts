import { token } from '@caffeinejs/di'
import { authConfigSchema, newRouter } from '@caffeinejs/http'
import { $t, newConfiguration } from '@caffeinejs/std'
import { EnvConfigSource, type InferConfig } from '@caffeinejs/std/config'
import { describe, expect, it } from 'vitest'

import { startApp } from './internal/app.js'
import { Browser } from './internal/browser/index.js'
import { localJWT } from './internal/tokens.js'

/**
 * Authentication options arriving from the environment, through the schema the package exports for the block.
 * That schema leaves each scheme's keys open, so nothing upstream turns the text of an environment variable into
 * the boolean or the number an option is.
 */

const schema = $t.Object({ auth: $t.Object({ ...authConfigSchema.properties }, { default: {} }) })
const kConfig = token<InferConfig<typeof schema>>(Symbol('e2e.auth.config'))

function configuredFrom(env: Record<string, string>) {
  return newConfiguration(schema, kConfig).source(new EnvConfigSource({ env })).build()
}

function start(env: Record<string, string>) {
  return startApp(
    app =>
      app
        // Named in lower case: an environment variable cannot address a scheme called `Bearer`.
        .authentication((auth, c) => auth.config(c.auth).addJWTBearer('jwt', localJWT))
        .mount(
          newRouter('/whoami')
            .authorize({})
            .get('/', () => ({ ok: true })),
        ),
    { config: configuredFrom(env) },
  )
}

describe('authentication options set from the environment', () => {
  // "false" is a non-empty string, and a non-empty string is true.
  it('turns an option off when the variable says false', async () => {
    const running = await start({ AUTH__SCHEMES__JWT__INCLUDE_ERROR_DETAILS: 'false' })

    try {
      const response = await new Browser().xhr(`${running.origin}/whoami`, {
        headers: { authorization: 'Bearer not-a-token' },
      })

      expect(response.status).toBe(401)
      expect(response.headers['www-authenticate']).toBe('Bearer error="invalid_token"')
    } finally {
      await running.close()
    }
  })

  // A misspelt key used to be dropped, so the check the operator believed was on never ran.
  it('refuses to start on a key the scheme does not have', async () => {
    const error = await start({ AUTH__SCHEMES__JWT__AUDIANCE: 'someone-else' }).then(
      running => running.close().then(() => undefined),
      (e: Error) => e,
    )

    expect(error).toMatchObject({ code: 'ERR_AUTH_CONFIGURATION' })
    expect(error?.message).toContain('"audiance"')
    expect(error?.message).toContain('"audience"')
  })

  it('refuses to start on a value that is not what the option takes', async () => {
    const error = await start({ AUTH__SCHEMES__JWT__INCLUDE_ERROR_DETAILS: 'maybe' }).then(
      running => running.close().then(() => undefined),
      (e: Error) => e,
    )

    expect(error).toMatchObject({ code: 'ERR_AUTH_CONFIGURATION' })
    expect(error?.message).toContain('includeErrorDetails')
  })
})
