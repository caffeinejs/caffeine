import { token } from '@caffeinejs/di'
import { newRouter, Authentication, authentication } from '@caffeinejs/http'
import { newConfiguration } from '@caffeinejs/std'
import type { InferConfig } from '@caffeinejs/std/config'
import { EnvConfigSource } from '@caffeinejs/std/config/env'
import { $t } from '@caffeinejs/std/schema'
import { describe, expect, it } from 'vitest'

import { startApp } from './internal/app.js'
import { Browser } from './internal/browser/index.js'
import { localJWT } from './internal/tokens.js'

/**
 * Authentication options arriving from the environment, through an application schema keyed by scheme name with
 * each key typed, so loading the configuration turns the text of an environment variable into the boolean or the
 * number an option is.
 */

const schema = $t.Object({
  auth: $t.Object(
    {
      schemes: $t.Optional(
        $t.Record(
          $t.String(),
          $t.Object({
            includeErrorDetails: $t.Optional($t.Boolean()),
            clientId: $t.Optional($t.String()),
            callbackUrl: $t.Optional($t.String()),
          }),
        ),
      ),
    },
    { default: {} },
  ),
})
const kConfig = token<InferConfig<typeof schema>>(Symbol('e2e.auth.config'))

function configuredFrom(env: Record<string, string>) {
  return newConfiguration(schema, kConfig).source(new EnvConfigSource({ env })).build()
}

function start(env: Record<string, string>) {
  return startApp(
    app =>
      app
        // Named in lower case: an environment variable cannot address a scheme called `Bearer`.
        .install(Authentication((auth, { config }) => auth.config(config.auth).addJWTBearer('jwt', localJWT)))
        .with(authentication())
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

  it('refuses to start on a value that is not what the option takes', async () => {
    const error = await start({ AUTH__SCHEMES__JWT__INCLUDE_ERROR_DETAILS: 'maybe' }).then(
      running => running.close().then(() => undefined),
      (e: Error) => e,
    )

    expect(error).toMatchObject({ code: 'ERR_CONFIG_VALIDATION' })
    expect(error?.message).toContain('includeErrorDetails')
  })

  // The client id is what a deployment most often sets this way, and `CLIENT_ID` folds to `clientId`: the key has
  // to be spelled the way the variable folds, or the variable never reaches the option.
  it('takes an OAuth 2.0 client id and callback URL from the variables a deployment would write', async () => {
    const running = await startApp(
      app =>
        app
          .install(
            Authentication((auth, { config }) =>
              auth
                .config(config.auth)
                .addOAuth2('oauth', o =>
                  o
                    .clientID('code-client')
                    .clientSecret('code-client-secret')
                    .sessionSecret('e2e-session-secret-at-least-32-chars!!')
                    .authorizationEndpoint('https://provider.invalid/authorize')
                    .tokenEndpoint('https://provider.invalid/token')
                    .userInfoEndpoint('https://provider.invalid/userinfo')
                    .callbackURL('http://localhost/auth/callback'),
                ),
            ),
          )
          .with(authentication()),
      {
        config: configuredFrom({
          AUTH__SCHEMES__OAUTH__CLIENT_ID: 'env-client',
          AUTH__SCHEMES__OAUTH__CALLBACK_URL: 'http://localhost/signin/callback',
        }),
      },
    )

    try {
      // `xhr` does not follow the redirect, so the URL the browser would be sent to is there to read.
      const response = await new Browser().xhr(`${running.origin}/signin/callback/login`)
      expect(response.status).toBe(302)

      const authorization = new URL(String(response.headers.location))
      expect(authorization.origin).toBe('https://provider.invalid')
      expect(authorization.searchParams.get('client_id')).toBe('env-client')
      expect(authorization.searchParams.get('redirect_uri')).toBe('http://localhost/signin/callback')
    } finally {
      await running.close()
    }
  })
})
