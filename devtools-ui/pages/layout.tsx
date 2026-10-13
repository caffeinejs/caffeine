import type { Children } from '@kitajs/html'

import { STYLE_PATH } from '../style.js'

/** What the side navigation lists: every configured application, and the slices the current one serves. */
export interface Nav {
  applications: readonly string[]
  application?: string
  /** The ids the application's index listed. */
  slices?: readonly string[]
  /** The slice the page shows. */
  active?: string
}

/**
 * A path into the UI, each segment encoded. An id a remote application sent reaches an href only through here.
 */
export function href(...segments: string[]): string {
  return `/${segments.map(segment => encodeURIComponent(segment)).join('/')}`
}

export function Layout(props: { title: string; nav: Nav; children?: Children }): JSX.Element {
  const { applications, application, slices, active } = props.nav

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title safe>{props.title} · Caffeine DevTools</title>
        <link rel="stylesheet" href={STYLE_PATH} />
      </head>
      <body>
        <header>
          <a class="brand" href="/">
            Caffeine DevTools
          </a>
        </header>
        <div class="shell">
          <nav>
            <h2>Applications</h2>
            <ul>
              {applications.map(name => (
                <li>
                  <a href={href(name)} class={name === application && active === undefined ? 'active' : undefined} safe>
                    {name}
                  </a>
                </li>
              ))}
            </ul>
            {application !== undefined && slices !== undefined && slices.length > 0 ? (
              <>
                <h2 safe>{application}</h2>
                <ul>
                  {slices.map(id => (
                    <li>
                      <a href={href(application, id)} class={id === active ? 'active' : undefined} safe>
                        {id}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              ''
            )}
          </nav>
          <main>{props.children}</main>
        </div>
      </body>
    </html>
  )
}

/** A status word, coloured by how good it is. */
export function Badge(props: { tone: 'ok' | 'warn' | 'bad' | 'muted'; children: string }): JSX.Element {
  return (
    <span class={`badge ${props.tone}`} safe>
      {props.children}
    </span>
  )
}
