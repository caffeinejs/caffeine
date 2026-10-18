import { describe, expect, it } from 'vitest'

import { brewer } from '../index.js'

const client = brewer('http://localhost')

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(chunk))
      controller.close()
    },
  })
}

describe('$progress', () => {
  it('passes every chunk through as it is, in order, and reports the bytes so far after each', async () => {
    const reported: number[] = []
    const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4]), new Uint8Array([5, 6, 7, 8])]

    const through = await Array.fromAsync(
      streamOf(...chunks).pipeThrough(client.$progress(loaded => reported.push(loaded))),
    )

    expect(through).toEqual(chunks)
    expect(reported).toEqual([3, 4, 8])
  })

  it('counts what a body reads, so the last report is its whole length', async () => {
    const reported: number[] = []
    const body = new Response(new Uint8Array(100_000)).body!

    const bytes = await new Response(body.pipeThrough(client.$progress(loaded => reported.push(loaded)))).bytes()

    expect(bytes.byteLength).toBe(100_000)
    expect(reported.at(-1)).toBe(100_000)
    expect(reported).toEqual([...reported].sort((a, b) => a - b))
  })

  it('reports nothing for an empty stream', async () => {
    const reported: number[] = []

    await Array.fromAsync(streamOf().pipeThrough(client.$progress(loaded => reported.push(loaded))))

    expect(reported).toEqual([])
  })

  it('fails the stream when the report fails, rather than losing the error', async () => {
    const counted = streamOf(new Uint8Array([1])).pipeThrough(
      client.$progress(() => {
        throw new Error('the progress bar is gone')
      }),
    )

    await expect(Array.fromAsync(counted)).rejects.toThrow('the progress bar is gone')
  })
})
