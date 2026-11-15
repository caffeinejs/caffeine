import { Byte } from '@caffeinejs/std/bytes'
import { describe, expect, it } from 'vitest'

import { ErrHTTPBadRequest, ErrHTTPContentTooLarge, ErrHTTPUnsupportedMediaType } from '../error/http.js'
import {
  declaredOver,
  ErrRequestBodyConsumed,
  isBodyLimit,
  limitStream,
  parsedMediaType,
  parseBody,
  readLimited,
} from './body.js'

const encode = (text: string) => new TextEncoder().encode(text)

function streamOf(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++])
      } else {
        controller.close()
      }
    },
    cancel() {
      onCancel?.()
    },
  })
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return readLimited(stream, Number.MAX_SAFE_INTEGER)
}

describe('parsedMediaType', () => {
  it('ignores parameters', () => {
    expect(parsedMediaType('application/json; charset=utf-8')).toBe('application/json')
  })

  it.each(['text/plain', 'application/x-www-form-urlencoded'])('parses %s', type => {
    expect(parsedMediaType(type)).toBe(type)
  })

  it.each(['application/xml', 'nonsense', 'application/jsonp'])('answers 415 for %s', type => {
    let caught: unknown
    try {
      parsedMediaType(type)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ErrHTTPUnsupportedMediaType)
    expect((caught as ErrHTTPUnsupportedMediaType).statusCode).toBe(415)
  })
})

describe('parseBody', () => {
  const json = (text: string) => () => parseBody('application/json', encode(text))

  it('parses valid JSON', () => {
    expect(json('{"a":1}')()).toEqual({ a: 1 })
  })

  it('answers 400 for an empty JSON body', () => {
    expect(() => parseBody('application/json', new Uint8Array(0))).toThrow(ErrHTTPBadRequest)
  })

  it('answers 400 without echoing the invalid body', () => {
    let caught: unknown
    try {
      json('{a')()
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(ErrHTTPBadRequest)
    expect((caught as ErrHTTPBadRequest).statusCode).toBe(400)
    expect((caught as ErrHTTPBadRequest).message).not.toContain('{a')
  })

  it.each([
    ['__proto__', '{"__proto__":{}}'],
    ['an escaped __proto__', '{"\\u005f_proto__":{}}'],
    ['constructor.prototype', '{"constructor":{"prototype":{}}}'],
  ])('answers 400 for a body holding %s', (_name, text) => {
    expect(json(text)).toThrow(ErrHTTPBadRequest)
  })

  it('returns text as a string', () => {
    expect(parseBody('text/plain', encode('hello'))).toBe('hello')
  })

  it('reads a form as a query string, into an object that inherits nothing', () => {
    const result = parseBody('application/x-www-form-urlencoded', encode('a=1&a=2&b&c=x+y'))

    expect(result).toEqual({ a: ['1', '2'], b: '', c: 'x y' })
    expect('toString' in (result as object)).toBe(false)
  })
})

describe('readLimited', () => {
  it('reads a stream of exactly the limit', async () => {
    expect(await readLimited(streamOf([encode('abc'), encode('de')]), 5 * Byte)).toEqual(encode('abcde'))
  })

  it('rejects with 413 one byte over the limit and cancels the source', async () => {
    let cancelled = false
    const source = streamOf([encode('abc'), encode('def')], () => {
      cancelled = true
    })

    const rejection = await readLimited(source, 5 * Byte).then(
      () => undefined,
      (err: unknown) => err,
    )

    expect(rejection).toBeInstanceOf(ErrHTTPContentTooLarge)
    expect((rejection as ErrHTTPContentTooLarge).statusCode).toBe(413)
    expect(cancelled).toBe(true)
  })

  it('reads null as empty', async () => {
    expect(await readLimited(null, 5 * Byte)).toEqual(new Uint8Array(0))
  })

  // The client left part-way: its request, not the server, is at fault.
  it('rejects with 400 when the stream fails part-way', async () => {
    let sent = false
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(new TypeError('terminated'))
        } else {
          sent = true
          controller.enqueue(encode('ab'))
        }
      },
    })

    await expect(readLimited(source, 10 * Byte)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('reads a multi-byte character split across chunks back whole', async () => {
    const bytes = await readLimited(streamOf([new Uint8Array([0xc3]), new Uint8Array([0xa9])]), 10 * Byte)

    expect(new TextDecoder().decode(bytes)).toBe('é')
  })
})

describe('limitStream', () => {
  it('fails with 413 once more than the limit has passed', async () => {
    const rejection = await drain(limitStream(streamOf([encode('abcdef'), encode('ghijk')]), 10 * Byte)).then(
      () => undefined,
      (err: unknown) => err,
    )

    expect(rejection).toBeInstanceOf(ErrHTTPContentTooLarge)
    expect((rejection as ErrHTTPContentTooLarge).statusCode).toBe(413)
  })

  it('reads a stream of exactly the limit whole', async () => {
    expect(await drain(limitStream(streamOf([encode('abcdef'), encode('ghij')]), 10 * Byte))).toEqual(
      encode('abcdefghij'),
    )
  })

  it('reads null as empty', async () => {
    expect(await drain(limitStream(null, 10 * Byte))).toEqual(new Uint8Array(0))
  })
})

describe('isBodyLimit', () => {
  it('accepts a whole number of bytes above 0', () => {
    expect(isBodyLimit(1)).toBe(true)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1kb'])('refuses %j', value => {
    expect(isBodyLimit(value)).toBe(false)
  })
})

describe('declaredOver', () => {
  it('is true only for a declared length above the limit', () => {
    expect(declaredOver('11', 10 * Byte)).toBe(true)
    expect(declaredOver('10', 10 * Byte)).toBe(false)
    expect(declaredOver(undefined, 10 * Byte)).toBe(false)
  })
})

describe('ErrRequestBodyConsumed', () => {
  it('carries its code and name, and names the route in its first line', () => {
    const err = new ErrRequestBodyConsumed('POST /pets')

    expect(err.code).toBe('ERR_REQUEST_BODY_CONSUMED')
    expect(err.name).toBe('ErrRequestBodyConsumed')
    expect(err.message.split('\n')[0]).toBe(
      'Cannot read the request body of "POST /pets": something read it before the route did',
    )
  })
})
