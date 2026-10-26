import { HTML } from '@caffeinejs/html'
import { Catch, ErrHTTP, type ActionResult, type ErrorHandler, type IContext } from '@caffeinejs/http'
import type { ContextPlatform } from '@caffeinejs/http/fastify'

import { TARGET_AUTHORIZATION_VARIABLE, TARGET_URL_VARIABLE, type Config } from '../../app.config.js'
import { Layout } from '../layout/Layout.js'
import { ErrDevToolsAnswered } from './answered.js'

/**
 * What the UI says when it cannot read the devtools: which URL it asked, what came back, and the variable that
 * changes it. Nothing it renders comes from the response body: a page must not show what a server sent unasked.
 */
export function TargetErrorPage(props: { target: string; status: number | undefined; reason: string }): JSX.Element {
  const hint =
    props.status === 401 || props.status === 403
      ? `The devtools require credentials: set ${TARGET_AUTHORIZATION_VARIABLE}, such as "Bearer <token>".`
      : props.status === undefined
        ? `Start the application with .install(DevTools()), or point ${TARGET_URL_VARIABLE} at where its devtools are served.`
        : `Check that ${TARGET_URL_VARIABLE} names the devtools path, such as http://127.0.0.1:9090/devtools.`

  return Layout({
    title: 'Cannot read the devtools',
    tools: undefined,
    target: props.target,
    active: '',
    children: (
      <section class="error">
        <p safe>{props.reason}</p>
        <p safe>{hint}</p>
      </section>
    ),
  })
}

/**
 * Renders a page that failed to read the devtools, keeping the status the devtools answered, and any other failure
 * as what it is: a page of the UI that failed.
 */
@Catch(Error)
export class TargetErrorHandler implements ErrorHandler<Error> {
  handle(ctx: IContext, err: Error): ActionResult {
    const config = ctx.config as Config

    if (!(err instanceof ErrDevToolsAnswered) && !isNetworkFailure(err)) {
      ;(ctx.platform as ContextPlatform).request.log.error({ err }, 'Cannot render the page')
      ctx.status(500)
      return HTML(
        Layout({
          title: 'Cannot show the page',
          tools: undefined,
          target: config.target.url,
          active: '',
          children: <p>The page failed to render. The UI log names the error.</p>,
        }),
      )
    }

    if (err instanceof ErrDevToolsAnswered) {
      ctx.status(err.status === 404 ? 404 : 502)
      return HTML(
        TargetErrorPage({
          target: config.target.url,
          status: err.status,
          reason: `The devtools answered ${err.status} ${err.statusText}.`,
        }),
      )
    }

    ctx.status(502)
    return HTML(
      TargetErrorPage({
        target: config.target.url,
        status: undefined,
        reason: `Cannot reach the devtools at ${config.target.url}: ${causeOf(err)}.`,
      }),
    )
  }
}

/** Renders a page of the UI's own that does not exist. */
@Catch(ErrHTTP)
export class PageErrorHandler implements ErrorHandler<ErrHTTP> {
  handle(ctx: IContext, err: ErrHTTP): ActionResult {
    const config = ctx.config as Config

    ctx.status(err.statusCode)
    return HTML(
      Layout({
        title: err.statusCode === 404 ? 'Not found' : 'Cannot show the page',
        tools: undefined,
        target: config.target.url,
        active: '',
        children: <p safe>{err.message}</p>,
      }),
    )
  }
}

/** What `fetch` throws when it reaches nothing: a `TypeError` whose cause is the socket's error. */
function isNetworkFailure(err: Error): boolean {
  return err instanceof TypeError && err.cause instanceof Error
}

/** The innermost cause's message: what `fetch` puts under its own `fetch failed`. */
function causeOf(err: Error): string {
  let at: unknown = err

  while (at instanceof Error && at.cause instanceof Error) {
    at = at.cause
  }

  const code = (at as { code?: unknown }).code

  return typeof code === 'string' ? code : at instanceof Error ? at.message : String(at)
}
