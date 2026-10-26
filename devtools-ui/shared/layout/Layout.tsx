import type { DevToolsIndex } from '@caffeinejs/devtools'
import type { Children } from '@kitajs/html'

/** Where the UI shows a tool: each tool's page is served under its id. */
export function pageOf(id: string): string {
  return `/${encodeURIComponent(id)}`
}

export interface LayoutProps {
  readonly title: string
  /** The tools the devtools list, for the navigation; `undefined` when they could not be read. */
  readonly tools: DevToolsIndex['tools'] | undefined
  /** Where the devtools are read from, shown in the header. */
  readonly target: string
  /** The path of the page, to mark its entry in the navigation. */
  readonly active: string
  /** A script the page needs besides the page chrome, under `/static`. */
  readonly scripts?: readonly string[]
  readonly children?: Children
}

/**
 * The page chrome every page shares: the navigation built from the tools the devtools list, and the target they are
 * read from.
 */
export function Layout(props: LayoutProps): JSX.Element {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <title safe>{`${props.title} · Caffeine devtools`}</title>
        <link rel="stylesheet" href="/static/site.css" />
      </head>
      <body>
        <header class="top">
          <a class="brand" href="/">
            Caffeine devtools
          </a>
          <span class="target" safe>
            {props.target}
          </span>
        </header>
        <div class="frame">
          <nav class="side">
            <a href="/" class={props.active === '/' ? 'active' : ''}>
              Overview
            </a>
            {(props.tools ?? []).map(tool => {
              const href = pageOf(tool.id)

              return (
                <a href={href} class={props.active === href ? 'active' : ''} title={tool.description}>
                  <span safe>{tool.title}</span>
                </a>
              )
            })}
          </nav>
          <main>
            <h1 safe>{props.title}</h1>
            {props.children}
          </main>
        </div>
        {(props.scripts ?? []).map(src => (
          <script src={src} defer />
        ))}
      </body>
    </html>
  )
}
