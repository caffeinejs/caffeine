import { describe, expect, it } from 'vitest'

import { ErrConfigValidation } from '../errors.js'
import { checkInterpolation, expandDotenv, mergeInterpolated } from '../interpolation.js'
import { mergeLayers } from '../merge.js'
import { freezeDeep, isPlainObject } from '../tree.js'
import type { ConfigLayer, ConfigObject } from '../types.js'

type Env = Record<string, string>

/** A layer as a file source hands it over: frozen, and interpolating. */
function file(data: Record<string, unknown>, name = 'file:app.json'): ConfigLayer {
  return { name, data: freezeDeep(structuredClone(data)) as ConfigObject, interpolate: true }
}

/** A layer from a source that does not interpolate, such as the environment or a config server. */
function plain(data: Record<string, unknown>, name = 'env'): ConfigLayer {
  return { name, data: freezeDeep(structuredClone(data)) as ConfigObject }
}

function merge(layers: readonly ConfigLayer[], env: Env = {}): Record<string, unknown> {
  return mergeInterpolated(layers, env) as Record<string, unknown>
}

function interpolate(value: string, env: Env = {}): unknown {
  return merge([file({ a: value })], env).a
}

function issuesOf(layers: readonly ConfigLayer[], env: Env = {}): ErrConfigValidation['issues'] {
  try {
    mergeInterpolated(layers, env)
  } catch (error) {
    expect(error).toBeInstanceOf(ErrConfigValidation)
    return (error as ErrConfigValidation).issues
  }
  return expect.fail('expected an ErrConfigValidation')
}

/** The error `checkInterpolation` throws for a file holding `value` at `a`. */
function malformed(value: string): Error {
  try {
    checkInterpolation({ a: value }, 'config/app.json')
  } catch (error) {
    return error as Error
  }
  return expect.fail(`expected "${value}" to be refused`)
}

describe('interpolation syntax', () => {
  const env = { NAME: 'test' }

  it.each([
    ['${env:NAME}', 'test'],
    ['hello ${env:NAME}!', 'hello test!'],
    ['${env:NAME}${env:NAME}', 'testtest'],
    ['${env:MISSING:-No Name}', 'No Name'],
    ['${env:MISSING:-}', ''],
    ['${env:MISSING:-a:b-c}', 'a:b-c'],
    ['${env:MISSING:-x:-y}', 'x:-y'],
    ['${env:MISSING:-$$}', '$$'],
  ])('reads %s as %s', (text, expected) => {
    expect(interpolate(text, env)).toBe(expected)
  })

  // `$` is special only in a run right before `{`, so a password holding `$$` elsewhere is never rewritten.
  it.each([
    ['$${env:NAME}', '${env:NAME}'],
    ['$$${env:NAME}', '$test'],
    ['$$$${env:NAME}', '$${env:NAME}'],
    ['pa$$word ${env:NAME}', 'pa$$word test'],
    ['costs $5, ${env:NAME}', 'costs $5, test'],
    ['${env:NAME}$', 'test$'],
    ['${env:NAME}}', 'test}'],
    ['$ {env:NAME} ${env:NAME}', '$ {env:NAME} test'],
    ['{env:NAME}', '{env:NAME}'],
    ['pa$$word', 'pa$$word'],
  ])('escapes %s to %s', (text, expected) => {
    expect(interpolate(text, env)).toBe(expected)
  })

  // Every case holds S3CRET, standing for a password that happens to contain `${`: an error must never echo it.
  it.each([
    ['${env:S3CRET', 'is not closed'],
    ['${}', 'needs a prefix and a key'],
    ['${S3CRET}', 'needs a prefix and a key'],
    ['${:S3CRET}', 'has a prefix other than "env" or "config"'],
    ['${evn:S3CRET}', 'has a prefix other than "env" or "config"'],
    ['${ENV:S3CRET}', 'has a prefix other than "env" or "config"'],
    ['${field:S3CRET}', 'has a prefix other than "env" or "config"'],
    ['${ env:S3CRET}', 'has a prefix other than "env" or "config"'],
    ['${env:}', 'has no key'],
    ['${env::-S3CRET}', 'has no key'],
    ['${env:1S3CRET}', 'names an environment variable'],
    ['${env:S3-CRET}', 'names an environment variable'],
    ['${env:S3 CRET}', 'names an environment variable'],
    ['${config:S3CRET..x}', 'has a config path with'],
    ['${config:.S3CRET}', 'has a config path with'],
    ['${config:S3CRET.}', 'has a config path with'],
    ['${config:S3 CRET}', 'has a config path with'],
    ['${config:S3$CRET}', 'has a config path with'],
    ['${env:NAME:S3CRET}', 'has something other than ":-" and a default'],
    ['${env:NAME:=S3CRET}', 'has something other than ":-" and a default'],
    ['${env:NAME:}', 'has something other than ":-" and a default'],
    ['${env:NAME:-S3CRET${env:OTHER}}', 'has a default that contains "${"'],
  ])('refuses %s: it %s', (text, reason) => {
    const error = malformed(text)

    expect(error).toMatchObject({ name: 'ErrConfig', code: 'ERR_CONFIG_INTERPOLATION' })
    expect(error.message).toContain(reason)
    expect(error.message).not.toContain('S3CRET')
  })

  it('names the file, the path and the character, and never the text', () => {
    let error: Error | undefined
    try {
      checkInterpolation({ db: { password: 'hunter${hunter2:x}' } }, 'config/app.json')
    } catch (thrown) {
      error = thrown as Error
    }

    expect(error?.message).toContain(
      'Cannot interpolate "db.password" in config file "config/app.json": the placeholder at character 7',
    )
    expect(error?.message).not.toContain('hunter')
  })

  it('checks strings inside arrays and nested objects', () => {
    expect(() => checkInterpolation({ servers: [{ host: 'ok' }, { host: '${evn:X}' }] }, 'app.json')).toThrow(
      'Cannot interpolate "servers.1.host"',
    )
  })

  it('accepts a file whose placeholders are well formed, and a key holding ${', () => {
    expect(() =>
      checkInterpolation({ '${key': 'v', a: '${env:A} ${config:b[0].c:-x}', n: 1, list: ['$${x}'] }, 'app.json'),
    ).not.toThrow()
  })
})

describe('interpolation of an environment variable', () => {
  it.each<[string, Env, string]>([
    ['${env:A}', { A: 'v' }, 'v'],
    ['${env:A}', { A: '' }, ''],
    ['${env:A:-d}', { A: 'v' }, 'v'],
    ['${env:A:-d}', { A: '' }, 'd'],
    ['${env:A:-d}', {}, 'd'],
  ])('reads %s with %j as %j', (text, env, expected) => {
    expect(interpolate(text, env)).toBe(expected)
  })

  // An unset variable is an error, not an empty string: an empty password or host fails later, and far from here.
  it('fails when the variable is unset and there is no default', () => {
    expect(issuesOf([file({ db: { host: '${env:DB_HOST}' } })])).toEqual([
      {
        path: 'db.host',
        message: 'cannot interpolate "${env:DB_HOST}" from "file:app.json": the environment variable is not set',
        code: 'ERR_CONFIG_INTERPOLATION',
      },
    ])
  })

  it('reads only the variables the environment holds, never what it inherits', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      expect(issuesOf([file({ a: `\${env:${name}}` })])).toHaveLength(1)
    }
  })
})

describe('interpolation of a config value', () => {
  it.each<[string, unknown, string]>([
    ['${config:x}', 'v', 'v'],
    ['${config:x}', 8080, '8080'],
    ['${config:x}', true, 'true'],
    ['${config:x}', false, 'false'],
    ['${config:x}', '', ''],
    ['${config:x:-d}', '', 'd'],
    ['${config:x:-d}', null, 'd'],
    ['${config:x:-d}', undefined, 'd'],
  ])('reads %s over %j as %j', (text, x, expected) => {
    expect(merge([file(x === undefined ? { a: text } : { a: text, x })]).a).toBe(expected)
  })

  it.each<[string, unknown, string]>([
    ['${config:x}', null, '"x" is not set'],
    ['${config:x}', undefined, '"x" is not set'],
    ['${config:x}', { k: 1 }, '"x" is an object, not a single value'],
    ['${config:x}', [1], '"x" is a list, not a single value'],
    ['${config:x:-d}', { k: 1 }, '"x" is an object, not a single value'],
  ])('refuses %s over %j', (text, x, reason) => {
    const [issue] = issuesOf([file(x === undefined ? { a: text } : { a: text, x })])

    expect(issue.path).toBe('a')
    expect(issue.message).toContain(reason)
  })

  it('reaches into a list, in either spelling', () => {
    const data = {
      servers: [{ host: 'h1' }, { host: 'h2' }],
      a: '${config:servers[1].host}',
      b: '${config:servers.0.host}',
    }

    expect(merge([file(data)])).toMatchObject({ a: 'h2', b: 'h1' })
  })

  // `length` belongs to the array that holds a list, not to the configuration.
  it.each([['${config:servers.length}'], ['${config:servers.first}']])(
    'reaches into a list by index only: %s',
    text => {
      const [issue] = issuesOf([file({ servers: ['h1', 'h2'], a: text })])

      expect(issue).toMatchObject({ path: 'a', message: expect.stringContaining('is not set') })
    },
  )

  it('interpolates the strings inside a list', () => {
    expect(merge([file({ tags: ['${env:A}', 'b'] })], { A: 'a' }).tags).toEqual(['a', 'b'])
  })
})

describe('interpolation scope', () => {
  it('sees a source registered before the file', () => {
    const layers = [
      plain({ team: { nickname: 'HELLO' } }, 'inline'),
      file({ app: { name: '${config:team.nickname}' } }),
    ]

    expect(merge(layers)).toMatchObject({ app: { name: 'HELLO' } })
  })

  // What the application reads and what a placeholder read never disagree: a later override flows into both.
  it('sees a source registered after the file', () => {
    const layers = [
      file({ db: { host: 'localhost', url: 'postgres://${config:db.host}/app' } }),
      plain({ db: { host: 'prod-db' } }),
    ]

    expect(merge(layers)).toMatchObject({ db: { host: 'prod-db', url: 'postgres://prod-db/app' } })
  })

  it('lets two files refer to each other, both ways', () => {
    const layers = [
      file({ a: 'from-a', x: '${config:b}' }, 'file:a.json'),
      file({ b: 'from-b', y: '${config:a}' }, 'file:b.json'),
    ]

    expect(merge(layers)).toMatchObject({ x: 'from-b', y: 'from-a' })
  })

  it('interpolates a referenced value before using it', () => {
    const layers = [
      file({ host: '${env:HOST:-localhost}' }, 'file:a.json'),
      file({ url: 'http://${config:host}:${env:PORT:-80}' }, 'file:b.json'),
    ]

    expect(merge(layers)).toMatchObject({ host: 'localhost', url: 'http://localhost:80' })
  })

  it('leaves a layer that does not interpolate as it is', () => {
    expect(merge([plain({ a: '${env:A}' })], { A: 'v' })).toEqual({ a: '${env:A}' })
  })
})

// A placeholder is filled in only where it decides a value: a base file's secret reference, overridden for local
// development, must not demand a variable nobody sets locally.
describe('interpolation laziness', () => {
  it('never fills in a placeholder a profile file overrides', () => {
    const layers = [
      file({ db: { password: '${env:DB_PASSWORD}' } }, 'file:app.json'),
      { ...file({ db: { password: 'dev' } }, 'file:app-dev.json'), profile: 'dev' },
    ]

    expect(merge(layers)).toEqual({ db: { password: 'dev' } })
  })

  it('never fills in a placeholder a later source overrides, nor one under a replaced object', () => {
    const layers = [
      file({ db: { password: '${env:DB_PASSWORD}' }, cache: { url: '${env:CACHE}' } }),
      plain({ db: { password: 'from-env' }, cache: 'off' }),
    ]

    expect(merge(layers)).toEqual({ db: { password: 'from-env' }, cache: 'off' })
  })
})

describe('interpolation chains', () => {
  it('follows a chain of references', () => {
    const data = { a: '${config:b}!', b: '${config:c}?', c: '${env:C}' }

    expect(merge([file(data)], { C: 'x' })).toEqual({ a: 'x?!', b: 'x?', c: 'x' })
  })

  it.each<[string, ConfigLayer[], string]>([
    ['itself', [file({ a: 'x${config:a}' })], 'a -> a'],
    ['a pair', [file({ a: '${config:b}', b: '${config:a}' })], 'a -> b -> a'],
    [
      'a pair across two sources',
      [file({ a: '${config:b}' }, 'file:a.json'), file({ b: '${config:a}' }, 'file:b.json')],
      'a -> b -> a',
    ],
  ])('names a loop through %s, at every value in it', (_label, layers, loop) => {
    const issues = issuesOf(layers)

    expect(issues.length).toBeGreaterThan(0)
    for (const issue of issues) {
      expect(issue.message).toContain('its references loop')
    }
    expect(issues.map(issue => issue.message).join()).toContain(loop)
  })

  // A doubling chain turns a few lines into gigabytes. The cap stops it where it first goes too far.
  it('refuses a value that grows past 1 MiB', () => {
    const data: Record<string, string> = { a0: 'x'.repeat(1024) }
    for (let i = 1; i <= 11; i++) {
      data[`a${i}`] = `\${config:a${i - 1}}\${config:a${i - 1}}`
    }

    expect(issuesOf([file(data)])).toEqual([
      {
        path: 'a11',
        message: 'cannot interpolate the value from "file:app.json": it is longer than 1048576 characters',
        code: 'ERR_CONFIG_INTERPOLATION',
      },
    ])
  })

  /** `n` values in one chain: `a0` refers to `a1`, and so on, and the last refers to plain text. */
  function chain(n: number): Record<string, string> {
    const data: Record<string, string> = {}
    for (let i = 0; i < n; i++) {
      data[`a${i}`] = `\${config:a${i + 1}}`
    }
    data[`a${n}`] = 'end'
    return data
  }

  it('follows a chain 32 values deep', () => {
    expect(Object.values(merge([file(chain(32))]))).toEqual(Array.from({ length: 33 }, () => 'end'))
  })

  // The chain fails where it starts, and only there: each value it goes through is shallow enough on its own.
  it('refuses a chain 33 values deep, at the value that starts it', () => {
    expect(issuesOf([file(chain(33))])).toEqual([
      {
        path: 'a0',
        message: 'cannot interpolate the value from "file:app.json": its references run more than 32 deep',
        code: 'ERR_CONFIG_INTERPOLATION',
      },
    ])
  })

  // Unbounded, one reference per stack frame, a chain of a few thousand values overflows the stack. Bounded, every
  // value more than 32 from the end fails as an issue.
  it('fails a chain thousands of values long with issues, never by overflowing the stack', () => {
    const issues = issuesOf([file(chain(3000))])

    expect(issues).toHaveLength(2968)
    expect(issues[0]).toMatchObject({ path: 'a0', message: expect.stringContaining('more than 32 deep') })
  })
})

// Only what the application's own authors wrote is ever read as a placeholder. Text that arrives through one, or
// from a source that does not interpolate, is data: reading it again is how a lookup becomes an injection.
describe('interpolation never reads twice', () => {
  it('takes what an environment variable holds as it is', () => {
    expect(interpolate('${env:A}', { A: '${env:B}', B: 'secret' })).toBe('${env:B}')
  })

  it('takes what another source holds as it is', () => {
    const layers = [plain({ raw: '${env:B}' }), file({ copy: '${config:raw}' })]

    expect(merge(layers, { B: 'secret' })).toEqual({ raw: '${env:B}', copy: '${env:B}' })
  })

  it('takes an escaped placeholder as text wherever it is read', () => {
    expect(merge([file({ a: '$${env:B}', b: '${config:a}' })], { B: 'secret' })).toEqual({
      a: '${env:B}',
      b: '${env:B}',
    })
  })
})

describe('interpolation safety', () => {
  it.each([['${config:__proto__.polluted}'], ['${config:constructor}'], ['${config:toString}']])(
    'never reaches a prototype through %s',
    text => {
      expect(issuesOf([file({ a: text })])[0].message).toContain('is not set')
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    },
  )

  // A placeholder is a value, not a node: a path through one reads nothing of its internals.
  it.each([['${config:b.text}'], ['${config:b.layer}'], ['${config:b.path}']])(
    'never reads into a value through %s',
    text => {
      expect(issuesOf([file({ a: text, b: '${env:B}' })], { B: 'v' })[0].message).toContain('is not set')
    },
  )
})

describe('interpolation errors', () => {
  // A source of your own can mark its layers without the check a file source runs as it reads. Its mistakes still
  // arrive as issues, with the character and never the text.
  it('reports a malformed placeholder from a source that never checked it', () => {
    const custom: ConfigLayer = { name: 'custom', data: freezeDeep({ a: 'x${evn:S3CRET}' }), interpolate: true }

    expect(issuesOf([custom])).toEqual([
      {
        path: 'a',
        message:
          'cannot interpolate the value from "custom": the placeholder at character 2 has a prefix other than "env" or "config"',
        code: 'ERR_CONFIG_INTERPOLATION',
      },
    ])
  })

  it('collects every value that cannot be interpolated', () => {
    const issues = issuesOf([file({ a: '${env:A}', b: '${env:B}', c: 'fine' })])

    expect(issues.map(issue => [issue.path, issue.code])).toEqual([
      ['a', 'ERR_CONFIG_INTERPOLATION'],
      ['b', 'ERR_CONFIG_INTERPOLATION'],
    ])
  })

  it('names the value at fault when it is another one', () => {
    const data = { db: { password: '${env:DB_PASSWORD}', url: 'postgres://u:${config:db.password}@h' } }

    expect(issuesOf([file(data)])).toEqual([
      {
        path: 'db.password',
        message: 'cannot interpolate "${env:DB_PASSWORD}" from "file:app.json": the environment variable is not set',
        code: 'ERR_CONFIG_INTERPOLATION',
      },
      {
        path: 'db.url',
        message:
          'cannot interpolate "${env:DB_PASSWORD}" at "db.password" from "file:app.json": the environment variable is not set',
        code: 'ERR_CONFIG_INTERPOLATION',
      },
    ])
  })

  // Messages reach logs, and devtools clients. A variable's value and a default are both text that may be secret.
  it('never quotes a value or a default', () => {
    const data = {
      url: 'https://${env:TOKEN}@${config:missing}',
      other: '${config:obj:-default-s3cret}',
      obj: { k: 1 },
    }

    let error: ErrConfigValidation | undefined
    try {
      mergeInterpolated([file(data)], { TOKEN: 'super-s3cret' })
    } catch (thrown) {
      error = thrown as ErrConfigValidation
    }

    expect(error?.issues).toHaveLength(2)
    expect(error?.message).not.toContain('s3cret')
  })
})

describe('interpolation purity', () => {
  it('changes no layer, and returns plain data only', () => {
    const layer = file({ a: '${env:A}', list: ['${env:A}'], nested: { b: '${config:a}' } })
    const before = structuredClone(layer.data)

    const out = merge([layer], { A: 'v' })

    expect(layer.data).toEqual(before)
    expect(Object.isFrozen(layer.data)).toBe(true)
    expect(out).toStrictEqual({ a: 'v', list: ['v'], nested: { b: 'v' } })
    expect(isPlainObject(out.nested)).toBe(true)
  })

  it('leaves keys and values other than strings alone', () => {
    const data = { '${env:A}': 1, n: 5, b: true, z: null }

    expect(merge([file(data)], { A: 'v' })).toEqual(data)
  })

  it('merges exactly as mergeLayers does when nothing holds ${', () => {
    const layers = [file({ a: 'x', b: { c: [1, '$5'] } }), plain({ b: { d: 'y' } })]

    expect(mergeInterpolated(layers, {})).toEqual(mergeLayers(layers))
  })
})

describe('dotenv expansion', () => {
  function expand(entries: Env, env: Env = {}): Record<string, string> {
    return Object.fromEntries(expandDotenv(new Map(Object.entries(entries)), env, 'config'))
  }

  /** The error `expandDotenv` throws for `entries`. */
  function refused(entries: Env): Error {
    try {
      expand(entries)
    } catch (error) {
      return error as Error
    }
    return expect.fail('expected the entries to be refused')
  }

  // The rule of a config file: a default stands in for an empty value too, and without one an empty value is empty,
  // not unset. Whether another entry or the environment holds the value makes no difference.
  it.each<[string, Env, Env, string]>([
    ['${env:A}', { A: '' }, {}, ''],
    ['${env:A}', {}, { A: '' }, ''],
    ['${env:A:-d}', { A: '' }, {}, 'd'],
    ['${env:A:-d}', {}, { A: '' }, 'd'],
  ])('reads %s with the entries %j and the environment %j as %j', (text, entries, env, expected) => {
    expect(expand({ ...entries, X: text }, env).X).toBe(expected)
  })

  // A doubling chain turns a few lines into gigabytes. The cap stops it where it first goes too far.
  it('refuses an entry that grows past 1 MiB, naming it', () => {
    const entries: Env = { A0: 'x'.repeat(1024) }
    for (let i = 1; i <= 11; i++) {
      entries[`A${i}`] = `\${env:A${i - 1}}\${env:A${i - 1}}`
    }

    expect(refused(entries)).toMatchObject({
      code: 'ERR_CONFIG_INTERPOLATION',
      message: 'Cannot interpolate "A11" from the dotenv files in "config": it is longer than 1048576 characters',
    })
  })

  /** `n` entries in one chain: `A0` reads `A1`, and so on, and the last is plain text. */
  function chain(n: number): Env {
    const entries: Env = {}
    for (let i = 0; i < n; i++) {
      entries[`A${i}`] = `\${env:A${i + 1}}`
    }
    entries[`A${n}`] = 'end'
    return entries
  }

  // The same depth a config file's chain may reach: the plain text it ends on is no step in it.
  it('follows a chain 32 entries deep', () => {
    expect(expand(chain(32)).A0).toBe('end')
  })

  it('refuses a chain 33 entries deep, naming the entry that starts it', () => {
    expect(refused(chain(33))).toMatchObject({
      code: 'ERR_CONFIG_INTERPOLATION',
      message: 'Cannot interpolate "A0" from the dotenv files in "config": its references run more than 32 deep',
    })
  })
})
