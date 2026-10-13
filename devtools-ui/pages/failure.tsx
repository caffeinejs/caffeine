import type { Failure } from '../failure.js'
import { Layout, type Nav } from './layout.js'

/** What a failure means, and the configuration key the reader can change about it. */
export function explain(application: string, failure: Failure): { title: string; detail: string; hint?: string } {
  const key = `applications.${application}`

  switch (failure.kind) {
    case 'unauthorized':
      return {
        title: 'Not authenticated',
        detail: `The application answered 401: it did not accept the credentials sent.`,
        hint: `Check "${key}.auth" against the scheme the application's DevTools authorize with.`,
      }
    case 'forbidden':
      return {
        title: 'Not authorized',
        detail: 'The application answered 403: the credentials were accepted, but they lack what DevTools requires.',
        hint: `Use credentials in "${key}.auth" that hold the roles or policies DevTools authorizes with.`,
      }
    case 'not-found':
      return {
        title: 'Not found',
        detail: 'The application answered 404: nothing is served there.',
        hint: `Check that "${key}.url" is the DevTools index, the path given to devTools(d => d.path(...)).`,
      }
    case 'server-error':
      return { title: 'Application error', detail: `The application answered ${failure.status}.` }
    case 'http-error':
      return { title: 'Unexpected answer', detail: `The application answered ${failure.status}.` }
    case 'timeout':
      return {
        title: 'Timed out',
        detail: 'The application did not answer in time.',
        hint: `Raise "${key}.timeout" if it is slow rather than stuck.`,
      }
    case 'unreachable':
      return {
        title: 'Cannot reach the application',
        detail: `The connection failed${failure.code === undefined ? '' : `: ${failure.code}`}.`,
        hint: `Check that the application is running, and that "${key}.url" names its ops server.`,
      }
    case 'invalid-response':
      return {
        title: 'Not a DevTools answer',
        detail: 'The application answered with something that is not what DevTools serves.',
        hint: `Check that "${key}.url" is the DevTools index.`,
      }
  }
}

/** The status the UI answers a failed call to an application with: it is the gateway, and the upstream failed. */
export function statusOf(failure: Failure): number {
  return failure.kind === 'timeout' ? 504 : 502
}

export function FailurePage(props: { nav: Nav; application: string; failure: Failure }): JSX.Element {
  const { title, detail, hint } = explain(props.application, props.failure)

  return (
    <Layout title={title} nav={props.nav}>
      <h1 safe>{title}</h1>
      <div class="problem">
        <p safe>{detail}</p>
        {hint === undefined ? (
          ''
        ) : (
          <p class="muted" safe>
            {hint}
          </p>
        )}
      </div>
    </Layout>
  )
}

export function NotFoundPage(props: { nav: Nav; what: string }): JSX.Element {
  return (
    <Layout title="Not found" nav={props.nav}>
      <h1>Not found</h1>
      <p class="lead" safe>
        {props.what}
      </p>
    </Layout>
  )
}
