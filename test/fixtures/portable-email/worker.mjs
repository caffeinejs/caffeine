import { respond } from './consumer.js'

export default {
  async test() {
    for (const name of ['Buffer', 'process', 'Bun']) {
      if (typeof globalThis[name] !== 'undefined') {
        throw new Error(`Unexpected host global: ${name}`)
      }
    }

    try {
      // oxlint-disable-next-line typescript/no-implied-eval -- this control must fail if the host enables string compilation.
      new Function('return 1')
      throw new Error('The worker allows dynamic code generation')
    } catch (error) {
      if (!(error instanceof EvalError)) {
        throw error
      }
    }

    const response = respond(new Request('https://fixture.invalid/welcome'))
    if (response.status !== 200 || response.headers.get('content-type') !== 'text/plain; charset=utf-8') {
      throw new Error('Unexpected response status or content type')
    }
    if ((await response.text()) !== '/welcome') {
      throw new Error('The streamed response lost its request path')
    }
  },
}
