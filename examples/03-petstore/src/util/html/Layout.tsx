import type { Children } from '@kitajs/html'

/**
 * The page chrome every rendered page shares.
 *
 * `@kitajs/html` has no layout mechanism because it needs none: a layout is a component that takes children,
 * and a page calls it. The doctype is left to the `html` feature, which prefixes one unless the markup already
 * carries it.
 */
export function Layout(props: { title: string; children?: Children }): JSX.Element {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title safe>{props.title}</title>
        <link rel="stylesheet" href="/static/site.css" />
      </head>
      <body>{props.children}</body>
    </html>
  )
}
