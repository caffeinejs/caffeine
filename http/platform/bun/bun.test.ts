import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { Agent, get as httpGet, request as httpRequest } from 'node:http'
import { get as httpsGet } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Byte, KiB } from '@caffeinejs/std/bytes'
import { afterEach, describe, expect, it } from 'vitest'

import { createWebApplication } from '../../application.js'
import { ErrConfiguration } from '../../core/error/common.js'
import { bun } from './bun.js'

const fixture = fileURLToPath(new URL('./_testdata/serve.ts', import.meta.url))
const cert = readFileSync(new URL('../../_tests/_testdata/tls/localhost.crt', import.meta.url))

describe('bun() outside Bun', () => {
  it('refuses to start, so a Node process never serves nothing', async () => {
    const app = createWebApplication({ adapter: bun() })

    const failure = await app.bootstrap().then(
      () => undefined,
      (err: unknown) => err,
    )

    expect(failure).toBeInstanceOf(ErrConfiguration)
    expect((failure as Error).message.split('\n')[0]).toBe('Cannot serve with the Bun adapter: this runtime is not Bun')
    await app.close()
  })
})

/** One line the fixture printed: a `serverCallback`'s, where it listens, or what a fixture route or flag reports. */
type Line = Record<string, unknown>

/** A `bun` process running the fixture, with every line it printed. */
interface Fixture {
  readonly child: ChildProcess
  /** Resolves with the first line `matches` takes, printed or still to come; rejects if the process exits first. */
  line(matches: (line: Line) => boolean): Promise<Line>
  /** The lines printed before the first that `matches` takes. */
  before(matches: (line: Line) => boolean): readonly Line[]
}

/** Where the fixture listens, from the line it prints once `run()` has resolved. */
interface Served extends Fixture {
  readonly host: string
  readonly origin: string
  readonly path: string
  /** Where the fixture's `admin` listener listens, when it was asked for one. */
  readonly admin: string | undefined
}

const children: ChildProcess[] = []

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      child =>
        new Promise<void>(resolve => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve()
            return
          }
          child.once('exit', () => resolve())
          child.kill('SIGKILL')
        }),
    ),
  )
})

/** Optional behaviors exercised by the fixture. */
interface FixtureFlags {
  readonly listener?: boolean
  readonly failCallback?: boolean
  readonly backgroundWork?: boolean
}

/** Starts the fixture with `settings`, `run(options)` and `flags`. */
function start(settings: object, options: object = {}, flags: FixtureFlags = {}): Fixture {
  const child = spawn('bun', [fixture, JSON.stringify(settings), JSON.stringify(options), JSON.stringify(flags)], {
    stdio: [flags.backgroundWork === true ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })
  children.push(child)

  const lines: Line[] = []
  const waiting = new Set<() => void>()
  let buffered = ''
  let stderr = ''
  let exit: number | null | undefined

  child.stderr!.on('data', chunk => (stderr += String(chunk)))
  child.stdout!.on('data', chunk => {
    buffered += String(chunk)
    let end: number
    while ((end = buffered.indexOf('\n')) !== -1) {
      const text = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      // The logger's own lines are not JSON: only the fixture's are.
      try {
        lines.push(JSON.parse(text) as Line)
      } catch {
        continue
      }
      waiting.forEach(wake => wake())
    }
  })
  child.once('exit', code => {
    exit = code
    waiting.forEach(wake => wake())
  })
  // No `bun` to start, as without one on PATH: fail the waiters at once rather than wait for an exit that never comes.
  child.once('error', err => {
    exit = null
    stderr += String(err)
    waiting.forEach(wake => wake())
  })

  return {
    child,
    line: matches =>
      new Promise((resolve, reject) => {
        const wake = (): void => {
          const found = lines.find(matches)
          if (found !== undefined) {
            waiting.delete(wake)
            resolve(found)
          } else if (exit !== undefined) {
            waiting.delete(wake)
            reject(new Error(`bun exited with ${exit} first: ${stderr}`))
          }
        }
        waiting.add(wake)
        wake()
      }),
    before: matches => {
      const index = lines.findIndex(matches)
      return index === -1 ? lines : lines.slice(0, index)
    },
  }
}

/** Starts the fixture, and resolves once it prints where it listens; rejects if it exits first. */
async function serve(settings: object, options: object = {}, flags: FixtureFlags = {}): Promise<Served> {
  const running = start(settings, options, flags)
  const where = await running.line(line => 'origin' in line)

  return {
    ...running,
    host: where.host as string,
    origin: where.origin as string,
    path: where.path as string,
    admin: where.admin as string | undefined,
  }
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode)
      return
    }
    child.once('exit', code => resolve(code))
  })
}

// A body of `parts`, one chunk each, that declares no length: fetch sends it chunked.
function chunked(...parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part))
      }
      controller.close()
    },
  })
}

// A real `bun` process starts in well under a second; the budget covers a busy machine.
describe('bun() on Bun', { timeout: 30_000 }, () => {
  it("reports Bun's socket peer through ctx.server and the address picker with a trusted proxy", async () => {
    const { origin } = await serve({ listen: { host: '127.0.0.1', port: 0 }, trustProxy: '127.0.0.1' })

    const res = await fetch(`${origin}/who`, { headers: { 'x-forwarded-for': '203.0.113.1' } })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ platform: 'fetch', ip: '127.0.0.1', remoteAddress: '127.0.0.1' })
  })

  it('lets registered work outlive a live response and drains it before onClose', async () => {
    const { child, origin, line, before } = await serve(
      { listen: { host: '127.0.0.1', port: 0 } },
      {},
      { backgroundWork: true },
    )
    const response = await fetch(`${origin}/work`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('answered')

    child.stdin!.write('close\n')
    const closing = (printed: Line): boolean => 'closingStatus' in printed
    expect(await line(closing)).toEqual({ closingStatus: 503 })
    const lifecycle = (printed: Line): boolean => 'workCompleted' in printed || 'onClose' in printed
    expect(before(closing).filter(lifecycle)).toEqual([])

    child.stdin!.end('release\n')
    const closed = (printed: Line): boolean => printed.closed === true
    await line(closed)
    expect(before(closed).filter(lifecycle)).toEqual([{ workCompleted: true }, { onClose: true }])
    expect(await exited(child)).toBe(0)
  })

  it('listens on localhost on a port the OS assigns when nothing is set', async () => {
    const { host, origin } = await serve({})
    const port = Number(new URL(origin).port)

    // Bun reports the address `localhost` resolved to, as Node does.
    expect(['127.0.0.1', '::1']).toContain(host)
    expect(port).toBeGreaterThan(0)
    expect(port).not.toBe(3000)
  })

  it('reports the Unix socket run(options) bound, as the address a client connects to', async () => {
    const socket = join(mkdtempSync(join(tmpdir(), 'caffeine-bun-')), 'app.sock')

    const { origin, path } = await serve({}, { path: socket })

    expect(path).toBe(socket)
    expect(origin).toBe('')
  })

  it('serves TLS from the https section', async () => {
    const { origin } = await serve({ listen: { host: '127.0.0.1', port: 0 }, https: true })

    expect(origin.startsWith('https://127.0.0.1:')).toBe(true)

    const status = await new Promise<number>((resolve, reject) => {
      httpsGet(`${origin}/who`, { ca: cert, servername: 'localhost' }, res => {
        res.resume()
        resolve(res.statusCode!)
      }).once('error', reject)
    })

    expect(status).toBe(200)
  })

  it('hands serverCallback the started Bun server before it reports where it listens', async () => {
    const { origin, before } = await serve({ listen: { host: '127.0.0.1', port: 0 } })

    expect(before(line => 'origin' in line)).toEqual([{ callback: Number(new URL(origin).port) }])
  })

  it('serves a listener on its own port, with the routes bound to it alone', async () => {
    const { origin, admin } = await serve({ listen: { host: '127.0.0.1', port: 0 } }, {}, { listener: true })

    expect(admin!.startsWith('http://127.0.0.1:')).toBe(true)
    expect(admin).not.toBe(origin)
    expect(await (await fetch(`${admin}/admin`)).json()).toEqual({ admin: true })
    expect((await fetch(`${origin}/admin`)).status).toBe(404)
  })

  it('fails start-up when a serverCallback throws, and stops the Bun server it was handed', async () => {
    const running = start({ listen: { host: '127.0.0.1', port: 0 } }, {}, { failCallback: true })

    // The fixture probes, from inside, the port the callback was handed, once run() has failed.
    expect(await running.line(line => 'failed' in line)).toEqual({ failed: 'callback failed', reachable: false })
    expect(await exited(running.child)).toBe(1)
  })

  it('reads a JSON body framed by Content-Length, and every request header by lower-case name', async () => {
    const { origin } = await serve({ listen: { host: '127.0.0.1', port: 0 } })

    const res = await fetch(`${origin}/echo`, {
      method: 'POST',
      body: JSON.stringify({ text: 'test', num: 99 }),
      headers: { 'content-type': 'application/json', 'X-Trace': 'abc' },
    })

    expect(res.status).toBe(200)
    const echoed = (await res.json()) as { body: unknown; headers: Record<string, string> }
    expect(echoed.body).toEqual({ text: 'test', num: 99 })
    expect(echoed.headers['x-trace']).toBe('abc')
    expect(echoed.headers['content-type']).toBe('application/json')
    expect(echoed.headers.host).toBe(new URL(origin).host)
  })

  // A header record holds strings: a repeated header must not reach a route as a list.
  it('reads a repeated Set-Cookie request header as its last value', async () => {
    const { origin } = await serve({ listen: { host: '127.0.0.1', port: 0 } })

    const echoed = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        `${origin}/echo`,
        { method: 'POST', headers: { 'content-type': 'application/json', 'set-cookie': ['a=1', 'b=2'] } },
        res => {
          let text = ''
          res.on('data', chunk => (text += String(chunk)))
          res.once('end', () => resolve(text))
        },
      )
      req.once('error', reject)
      req.end('{}')
    })

    expect((JSON.parse(echoed) as { headers: Record<string, unknown> }).headers['set-cookie']).toBe('b=2')
  })

  it('reads a chunked body under bodyLimit whole', async () => {
    const { origin } = await serve({ listen: { host: '127.0.0.1', port: 0 }, bodyLimit: 1 * KiB })

    const res = await fetch(`${origin}/echo`, {
      method: 'POST',
      body: chunked('{"text":', '"chunked"}'),
      headers: { 'content-type': 'application/json' },
      duplex: 'half',
    })

    expect(res.status).toBe(200)
    expect(((await res.json()) as { body: unknown }).body).toEqual({ text: 'chunked' })
  })

  it('refuses with 413 a body over bodyLimit that declares its length', async () => {
    const { origin } = await serve({ listen: { host: '127.0.0.1', port: 0 }, bodyLimit: 16 * Byte })

    const res = await fetch(`${origin}/echo`, {
      method: 'POST',
      body: JSON.stringify({ text: 'x'.repeat(20) }),
      headers: { 'content-type': 'application/json' },
    })

    expect(res.status).toBe(413)
  })

  it('refuses with 413 a chunked body over bodyLimit, counted as it streams', async () => {
    const { origin } = await serve({ listen: { host: '127.0.0.1', port: 0 }, bodyLimit: 16 * Byte })

    const res = await fetch(`${origin}/echo`, {
      method: 'POST',
      body: chunked('{"text":"', 'x'.repeat(20), '"}'),
      headers: { 'content-type': 'application/json' },
      duplex: 'half',
    })

    expect(res.status).toBe(413)
  })

  it('answers a request in flight before it exits on SIGTERM', async () => {
    const { child, origin, line } = await serve({ listen: { host: '127.0.0.1', port: 0 } })
    const held = fetch(`${origin}/hold`)
    await line(printed => printed.held === true)

    child.kill('SIGTERM')

    const res = await held
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ drained: true })
    expect(await exited(child)).toBe(0)
  })

  // An idle keep-alive connection must not hold the exit until Bun's 72 s idle cut, past this suite's budget.
  it('exits on SIGTERM with an idle keep-alive connection open', async () => {
    const { child, origin } = await serve({ listen: { host: '127.0.0.1', port: 0 } })
    const agent = new Agent({ keepAlive: true })

    try {
      const status = await new Promise<number>((resolve, reject) => {
        httpGet(`${origin}/who`, { agent }, res => {
          res.resume()
          res.once('end', () => resolve(res.statusCode!))
        }).once('error', reject)
      })
      expect(status).toBe(200)
      expect(Object.values(agent.freeSockets).flat()).toHaveLength(1)

      child.kill('SIGTERM')

      expect(await exited(child)).toBe(0)
    } finally {
      agent.destroy()
    }
  })
})
