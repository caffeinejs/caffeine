import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * An OAuth 2.0 provider small enough to say exactly what a spec needs it to say, for the answers the Spring server
 * cannot be made to give — a user whose identifier is a number, as GitHub's is.
 *
 * It signs nobody in: `/authorize` sends the browser straight back with a code, as a provider does for a user who
 * is already signed in and has already consented.
 */
export interface StubProvider {
  readonly origin: string
  close(): Promise<void>
}

export async function startStubProvider(userInfo: Record<string, unknown>): Promise<StubProvider> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub.invalid')

    if (url.pathname === '/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri')!)
      back.searchParams.set('code', 'stub-code')
      back.searchParams.set('state', url.searchParams.get('state')!)

      response.writeHead(302, { location: back.toString() }).end()
      return
    }

    response.setHeader('content-type', 'application/json')

    if (url.pathname === '/token') {
      response.end(JSON.stringify({ access_token: 'stub-access-token', token_type: 'Bearer', expires_in: 300 }))
      return
    }

    if (url.pathname === '/userinfo') {
      response.end(JSON.stringify(userInfo))
      return
    }

    response.writeHead(404).end('{}')
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))

  return {
    // `localhost`, which the package accepts over plain http; an address would do as well.
    origin: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve()))),
  }
}
