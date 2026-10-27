import { describe, expect, it } from 'vitest'

import { Layout, type LayoutProps } from './Layout.js'

/**
 * The chrome every page shares, as a browser receives it: the navigation a collapsed sidebar still shows, and the
 * switches `site.js` runs.
 */

const tools: NonNullable<LayoutProps['tools']> = [
  { id: 'di', title: 'Dependency injection', description: 'The bindings', links: [] },
  { id: 'runtime', title: 'Runtime', description: 'The process', links: [] },
  // A tool this UI has no icon of its own for.
  { id: 'queues', title: 'Queues', description: 'The queues', links: [] },
]

async function render(props: Partial<LayoutProps> = {}): Promise<string> {
  return Layout({ title: 'Runtime', tools, target: 'http://127.0.0.1:9090/devtools', active: '/runtime', ...props })
}

/** Each navigation entry as `[href, markup inside it]`. */
function entriesOf(page: string): Array<[string, string]> {
  const nav = /<nav class="side"[^>]*>([\s\S]*?)<\/nav>/.exec(page)![1]!

  return [...nav.matchAll(/<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map(([, href, body]) => [href!, body!])
}

describe('Layout', () => {
  it('draws an icon in every navigation entry, a tool it does not know included, so a collapsed sidebar still shows each', async () => {
    const entries = entriesOf(await render())

    expect(entries.map(([href]) => href)).toEqual(['/', '/di', '/runtime', '/queues'])
    for (const [, body] of entries) {
      expect(body).toMatch(/^\s*<svg class="icon"[^>]*aria-hidden="true">\s*<(path|rect|circle) /)
    }
  })

  it('keeps each label beside its icon, the text a collapsed sidebar shows as a tooltip', async () => {
    const labels = entriesOf(await render()).map(([, body]) => /<span class="label">([^<]*)<\/span>/.exec(body)?.[1])

    expect(labels).toEqual(['Overview', 'Dependency injection', 'Runtime', 'Queues'])
  })

  it("marks the page's own entry, and no other, as the current page", async () => {
    const page = await render()

    expect(page.match(/aria-current="page"/g)).toHaveLength(1)
    expect(page).toMatch(/<a href="\/runtime" class="nav-link active" aria-current="page"/)
  })

  it('offers the theme and sidebar switches, and loads the script that runs them before the body paints', async () => {
    const page = await render()
    const head = /<head>([\s\S]*)<\/head>/.exec(page)![1]!

    expect(head).toContain('<script src="/static/site.js"></script>')
    expect(page).toMatch(/<button type="button" class="icon-button" data-action="theme"/)
    expect(page).toMatch(/<button type="button" class="side-toggle" data-action="sidebar" aria-controls="side"/)
    expect(page).toContain('<nav class="side" id="side"')
  })

  it('links the CaffeineJS repository after the theme switch, in a new tab, with a star count to show until site.js fetches one', async () => {
    const actions = /<div class="top-actions">([\s\S]*?)<\/div>/.exec(await render())![1]!
    const link = /<a class="github-stars"([^>]*)>([\s\S]*?)<\/a>/.exec(actions)

    expect(link).not.toBeNull()
    expect(actions.indexOf('data-action="theme"')).toBeLessThan(link!.index)
    expect(link![1]).toContain('href="https://github.com/caffeinejs/caffeine"')
    expect(link![1]).toContain('target="_blank"')
    expect(link![1]).toContain('rel="noopener noreferrer"')
    expect(link![2]).toMatch(
      /<span class="visually-hidden">GitHub stars:<\/span>\s*<span class="stars" data-github-stars>\s*0\s*<\/span>/,
    )
  })

  it('shows where the devtools are read from in the header, escaped', async () => {
    const page = await render({ target: 'http://127.0.0.1:9090/<devtools>' })

    expect(page).toMatch(/<span class="target"[^>]*>[\s\S]*?<span>http:\/\/127\.0\.0\.1:9090\/&lt;devtools><\/span>/)
    expect(page).not.toContain('<devtools>')
  })

  it('leaves the tools heading out when the devtools could not be read, and keeps the overview', async () => {
    const page = await render({ tools: undefined, active: '' })

    expect(page).not.toContain('side-heading')
    expect(entriesOf(page).map(([href]) => href)).toEqual(['/'])
  })
})
