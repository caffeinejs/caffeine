import { describe, it, expect } from 'vitest'
import fastify from 'fastify'
import {
  Catch,
  Controller,
  ErrorHandler,
  Get,
  createWebApplication,
  fastifyAdapterFactory,
  type ActionResult,
  type Context,
} from '@caffeinejs/http'
import type { ServiceAPI } from '@caffeinejs/std'
import { HTML, HTMLBuilder, HTMLExt } from '../index.js'

function Document({ title }: { title: string }) {
  return (
    <html>
      <body>
        <h1 safe>{title}</h1>
      </body>
    </html>
  )
}

function Snippet({ title }: { title: string }) {
  return <div safe>{title}</div>
}

async function AsyncDocument({ title }: { title: string }) {
  const resolved = await Promise.resolve(title)
  return (
    <html>
      <body>{resolved}</body>
    </html>
  )
}

@Controller('/html')
class HTMLController {
  @Get('/document')
  document() {
    return HTML(<Document title="hello" />)
  }

  @Get('/fragment')
  fragment() {
    return HTML(<Snippet title="hello" />)
  }

  @Get('/async')
  async() {
    return HTML(<AsyncDocument title="hello" />)
  }

  @Get('/unsafe')
  unsafe() {
    return HTML(<div>{'<script>alert(1)</script>'}</div>)
  }

  @Get('/escaped')
  escaped() {
    return HTML(<div safe>{'<script>alert(1)</script>'}</div>)
  }

  @Get('/pre-doctyped')
  preDoctyped() {
    return HTML('<!doctype html><html><body>hello</body></html>')
  }

  @Get('/overridden')
  overridden() {
    return HTML(<Document title="hello" />, {
      contentType: 'application/xhtml+xml',
      doctype: false,
    })
  }
}

class ErrRenderHTML extends Error {}

@Catch(ErrRenderHTML)
class RenderHTMLHandler extends ErrorHandler<ErrRenderHTML> {
  handle(ctx: Context, error: ErrRenderHTML): ActionResult {
    ctx.status(404)
    return HTML(<Snippet title={error.message} />)
  }
}

@Controller('/html-error')
class HTMLErrorController {
  @Get('/boom')
  boom(): unknown {
    throw new ErrRenderHTML('missing')
  }
}

void [HTMLController, RenderHTMLHandler, HTMLErrorController]

function htmlApp(configure?: (h: ServiceAPI<HTMLBuilder>) => void) {
  return createWebApplication(fastifyAdapterFactory(fastify()), {})
    .extend(HTMLExt, configure)
    .build()
}

describe('HTML', () => {
  // Without a Responder setting it, Fastify answers a returned string with text/plain and a browser shows
  // the markup as source. Answering HTML under the right content type is the package's reason to exist.
  it('answers with text/html', async () => {
    const app = htmlApp()
    await app.ready()

    const res = await app.fetch('/html/document')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/html; charset=utf-8/)
  })

  // Rendering must not require any application wiring: HTML() falls back to HTML_DEFAULTS when no
  // HTMLExtension decorated the server. An application that only ever renders needs no plugin at all.
  it('renders in an application that never installed HTMLExt', async () => {
    const app = createWebApplication(fastifyAdapterFactory(fastify()), {}).build()
    await app.ready()

    const res = await app.fetch('/html/document')

    expect(res.headers.get('content-type')).toMatch(/^text\/html; charset=utf-8/)
    expect(await res.text()).toBe('<!doctype html><html><body><h1>hello</h1></body></html>')
  })

  // An async component makes the JSX expression a Promise<string> rather than a string, which is a
  // separate branch of respond() and a separate adapter dispatch path.
  it('awaits an asynchronous component', async () => {
    const app = htmlApp()
    await app.ready()

    const res = await app.fetch('/html/async')

    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(await res.text()).toBe('<!doctype html><html><body>hello</body></html>')
  })

  describe('auto doctype', () => {
    // A browser without a doctype falls into quirks mode, so a full document gets one it did not author.
    it('prefixes a document', async () => {
      const app = htmlApp()
      await app.ready()

      expect(await (await app.fetch('/html/document')).text()).toMatch(/^<!doctype html><html>/)
    })

    // A fragment is spliced into an existing document, where a doctype would be invalid markup.
    it('leaves a fragment alone', async () => {
      const app = htmlApp()
      await app.ready()

      expect(await (await app.fetch('/html/fragment')).text()).toBe('<div>hello</div>')
    })

    it('does not double an authored doctype', async () => {
      const app = htmlApp()
      await app.ready()

      expect(await (await app.fetch('/html/pre-doctyped')).text())
        .toBe('<!doctype html><html><body>hello</body></html>')
    })
  })

  // The builder's settings only matter if they survive the trip through HTMLExtension's Fastify
  // decoration and back out through ctx.fst in respond() — the only route a Responder has to app state.
  it('applies the application defaults', async () => {
    const app = htmlApp(h => h.contentType('application/xhtml+xml').autoDoctype(false))
    await app.ready()

    const res = await app.fetch('/html/document')

    expect(res.headers.get('content-type')).toMatch(/^application\/xhtml\+xml/)
    expect(await res.text()).toBe('<html><body><h1>hello</h1></body></html>')
  })

  // One route answering differently must not require reconfiguring the application.
  it('lets a response override the application defaults', async () => {
    const app = htmlApp(h => h.contentType('text/html; charset=utf-8').autoDoctype(true))
    await app.ready()

    const res = await app.fetch('/html/overridden')

    expect(res.headers.get('content-type')).toMatch(/^application\/xhtml\+xml/)
    expect(await res.text()).toBe('<html><body><h1>hello</h1></body></html>')
  })

  describe('escaping', () => {
    // @kitajs/html escapes on request, not by default, and this package does not change that. Encoding it
    // here means a change to that model breaks a test rather than silently shipping an XSS hole.
    // Only `<` and `&` are replaced — enough to stop tag injection, so `>` survives verbatim.
    it('escapes children marked safe', async () => {
      const app = htmlApp()
      await app.ready()

      expect(await (await app.fetch('/html/escaped')).text())
        .toBe('<div>&lt;script>alert(1)&lt;/script></div>')
    })

    it('does not escape children that are not marked safe', async () => {
      const app = htmlApp()
      await app.ready()

      expect(await (await app.fetch('/html/unsafe')).text())
        .toBe('<div><script>alert(1)</script></div>')
    })
  })

  // Error handlers dispatch Responders through http/error/error_handling.ts, not through the adapter, so
  // an error page is a genuinely separate path from a handler's response.
  it('renders from an error handler', async () => {
    const app = htmlApp()
    await app.ready()

    const res = await app.fetch('/html-error/boom')

    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toMatch(/^text\/html/)
    expect(await res.text()).toBe('<div>missing</div>')
  })
})
