import { describe, expect, it } from 'vitest'

import { brewer } from '../index.js'

const client = brewer('http://localhost')

/** A response carrying only the headers a download names itself with. */
function named(disposition: string | undefined): Response {
  return new Response('x', disposition === undefined ? {} : { headers: { 'content-disposition': disposition } })
}

describe('$filename', () => {
  it.each([
    ['a quoted name', 'attachment; filename="report.pdf"', 'report.pdf'],
    ['a bare name', 'attachment; filename=report.pdf', 'report.pdf'],
    ['a name shown inline', 'inline; filename="chart.png"', 'chart.png'],
    ['a name holding spaces', 'attachment; filename="annual report.pdf"', 'annual report.pdf'],
    ['a name holding a semicolon', 'attachment; filename="q1;q2.csv"', 'q1;q2.csv'],
    ['a name holding an escaped quote', 'attachment; filename="the \\"final\\" cut.mp4"', 'the "final" cut.mp4'],
    ['parameter names in any case', 'Attachment; FileName="Upper.TXT"', 'Upper.TXT'],
    ['a parameter with no value before it', 'attachment; size; filename="x.txt"', 'x.txt'],
    ['spaces around the equals sign', 'attachment; filename = "spaced.txt"', 'spaced.txt'],
    ['the first of a repeated name', 'attachment; filename="first.txt"; filename="second.txt"', 'first.txt'],
  ])('reads %s', (_case, disposition, name) => {
    expect(client.$filename(named(disposition))).toBe(name)
  })

  // RFC 8187: `filename*` carries the name in UTF-8, and `filename` is the fallback for a reader that cannot decode it.
  it.each([
    ['a UTF-8 name', "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf", 'résumé.pdf'],
    ['a name beyond the basic plane', "attachment; filename*=utf-8''%F0%9F%90%B6.png", '🐶.png'],
    ['a Latin-1 name', "attachment; filename*=ISO-8859-1'en'%A3%20rates.txt", '£ rates.txt'],
    [
      'the encoded name over the plain one, written after it',
      'attachment; filename="resume.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf',
      'résumé.pdf',
    ],
    [
      'the encoded name over the plain one, written before it',
      'attachment; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf; filename="resume.pdf"',
      'résumé.pdf',
    ],
  ])('reads %s', (_case, disposition, name) => {
    expect(client.$filename(named(disposition))).toBe(name)
  })

  it.each([
    ['an escape that is not UTF-8', 'attachment; filename*=UTF-8\'\'%E0%A4%A; filename="plain.txt"'],
    ['a charset it cannot read', 'attachment; filename*=Shift_JIS\'\'%82%A0; filename="plain.txt"'],
    ['a value with no charset', 'attachment; filename*=plain.txt; filename="plain.txt"'],
  ])('falls back to the plain name past %s', (_case, disposition) => {
    expect(client.$filename(named(disposition))).toBe('plain.txt')
  })

  // A name is the server's word, and may be saved to disk as it is: it never gets to choose the directory.
  it.each([
    ['a relative path', 'attachment; filename="../../.ssh/authorized_keys"', 'authorized_keys'],
    ['an absolute path', 'attachment; filename="/etc/passwd"', 'passwd'],
    ['a Windows path', 'attachment; filename="C:\\\\Users\\\\Public\\\\run.bat"', 'run.bat'],
    ['an encoded path', "attachment; filename*=UTF-8''..%2F..%2Fevil.sh", 'evil.sh'],
    ['control characters', "attachment; filename*=UTF-8''line%0Abreak%00.txt", 'linebreak.txt'],
  ])('keeps only the base name of %s', (_case, disposition, name) => {
    expect(client.$filename(named(disposition))).toBe(name)
  })

  it.each([
    ['no header', undefined],
    ['no name', 'attachment'],
    ['only a parameter with no value', 'attachment; size'],
    ['an empty name', 'attachment; filename=""'],
    ['a name of dots', 'attachment; filename=".."'],
    ['a path ending in a separator', 'attachment; filename="reports/"'],
  ])('names nothing given %s', (_case, disposition) => {
    expect(client.$filename(named(disposition))).toBeUndefined()
  })
})

describe('$file', () => {
  it('reads the body into a File, named, typed and dated by the headers', async () => {
    const response = new Response(new Uint8Array([37, 80, 68, 70]), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="invoice.pdf"',
        'last-modified': 'Wed, 21 Oct 2026 07:28:00 GMT',
      },
    })

    const file = await client.$file(response)

    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('invoice.pdf')
    expect(file.type).toBe('application/pdf')
    expect(file.lastModified).toBe(Date.UTC(2026, 9, 21, 7, 28))
    expect(Array.from(await file.bytes())).toEqual([37, 80, 68, 70])
  })

  // As a browser names a download that carries no name: after the last segment of its URL.
  it('names a download that carries no name after the last segment of its URL', async () => {
    const response = {
      headers: new Headers(),
      url: 'https://cdn.test/files/q3%20report.csv?v=2',
      blob: async () => new Blob(['a,b']),
    }

    expect((await client.$file(response)).name).toBe('q3 report.csv')
  })

  it('keeps a URL segment it cannot decode as it is', async () => {
    const response = {
      headers: new Headers(),
      url: 'https://cdn.test/files/100%25%E0.csv',
      blob: async () => new Blob([]),
    }

    expect((await client.$file(response)).name).toBe('100%25%E0.csv')
  })

  it('names it with the fallback when neither the headers nor the URL name it', async () => {
    expect((await client.$file(new Response('x'))).name).toBe('download')
    expect((await client.$file(new Response('x'), 'export.csv')).name).toBe('export.csv')
    expect(
      (await client.$file({ headers: new Headers(), url: 'https://cdn.test/', blob: async () => new Blob([]) })).name,
    ).toBe('download')
  })

  it('dates it now when the server sends no date it can read', async () => {
    const before = Date.now()

    const file = await client.$file(new Response('x', { headers: { 'last-modified': 'not a date' } }))

    expect(file.lastModified).toBeGreaterThanOrEqual(before)
  })
})
