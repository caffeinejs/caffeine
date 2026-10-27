import type { DevToolsIndex } from '@caffeinejs/devtools'
import type { Children } from '@kitajs/html'

import { Icon, toolIcon, type IconName } from '../components/index.js'

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
 * The page chrome every page shares: the navigation built from the tools the devtools list, the target they are
 * read from, and the switches for the theme and the sidebar.
 */
export function Layout(props: LayoutProps): JSX.Element {
  const tools = props.tools ?? []

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="referrer" content="no-referrer" />
        <title safe>{`${props.title} · Caffeine devtools`}</title>
        <link rel="icon" href="/static/brand/logo.svg" type="image/svg+xml" />
        <link rel="icon" href="/static/brand/favicon-32.png" type="image/png" sizes="32x32" />
        <link rel="apple-touch-icon" href="/static/brand/apple-touch-icon.png" />
        <link rel="stylesheet" href="/static/site.css" />
        {/* Not deferred: it applies the theme and the sidebar a person chose before the page first paints. */}
        <script src="/static/site.js" />
      </head>
      <body>
        <header class="top">
          <a class="brand" href="/">
            {/* Decorative: the wordmark beside it names the link. */}
            <img class="brand-mark" src="/static/brand/logo.svg" width="24" height="24" alt="" />
            <span class="wordmark">
              caffeine<span class="wordmark-js">js</span>
            </span>
            <span class="brand-product">devtools</span>
          </a>
          <div class="top-actions">
            <span class="target" title="Where the devtools are read from">
              <Icon name="server" />
              <span safe>{props.target}</span>
            </span>
            <button
              type="button"
              class="icon-button"
              data-action="theme"
              title="Switch theme"
              aria-label="Switch theme"
            >
              <Icon name="moon" class="when-light" />
              <Icon name="sun" class="when-dark" />
            </button>
          </div>
        </header>
        <div class="frame">
          <nav class="side" id="side" aria-label="Tools">
            <NavLink href="/" label="Overview" icon="dashboard" active={props.active} />
            {tools.length === 0 ? '' : <p class="side-heading">Tools</p>}
            {tools.map(tool => (
              <NavLink
                href={pageOf(tool.id)}
                label={tool.title}
                hint={tool.description}
                icon={toolIcon(tool.id)}
                active={props.active}
              />
            ))}
            <button
              type="button"
              class="side-toggle"
              data-action="sidebar"
              aria-controls="side"
              aria-expanded="true"
              title="Collapse the sidebar"
            >
              <Icon name="chevrons" />
              <span class="label">Collapse</span>
            </button>
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

/** An entry of the navigation: its icon, and its label, which stands in as a tooltip when the sidebar is collapsed. */
function NavLink(
  props: Readonly<{ href: string; label: string; hint?: string; icon: IconName; active: string }>,
): JSX.Element {
  const current = props.active === props.href

  return (
    <a
      href={props.href}
      class={current ? 'nav-link active' : 'nav-link'}
      aria-current={current ? 'page' : undefined}
      title={props.hint}
    >
      <Icon name={props.icon} />
      <span class="label" safe>
        {props.label}
      </span>
    </a>
  )
}
