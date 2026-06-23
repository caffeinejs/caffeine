'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const root = path.resolve(__dirname, '../..')

// ---------------------------------------------------------------------------
// 1. Entry points load without error
// ---------------------------------------------------------------------------

const main = require(path.join(root, 'dist/commonjs/index.js'))
const decorators = require(path.join(root, 'dist/commonjs/decorators/index.js'))
const registrar = require(path.join(root, 'dist/commonjs/decorators/registrar/index.js'))
const testing = require(path.join(root, 'dist/commonjs/testing/index.js'))

// ---------------------------------------------------------------------------
// 2. Key named exports present
// ---------------------------------------------------------------------------

const requiredMainExports = ['DiCaf', 'Scopes', 'mod']
for (const name of requiredMainExports) {
  assert.ok(name in main, `main export missing: ${name}`)
}

const requiredDecoratorsExports = ['Injectable', 'Lazy', 'Lifetime', 'PostConstruct', 'PreDestroy']
for (const name of requiredDecoratorsExports) {
  assert.ok(name in decorators, `decorators export missing: ${name}`)
}

assert.ok('defineInjectable' in registrar, 'registrar: defineInjectable missing')
assert.ok('TestContainer' in testing, 'testing: TestContainer missing')

// ---------------------------------------------------------------------------
// 3. dist/commonjs/package.json stub exists and has correct content
// ---------------------------------------------------------------------------

const stub = JSON.parse(fs.readFileSync(path.join(root, 'dist/commonjs/package.json'), 'utf8'))
assert.equal(stub.type, 'commonjs', 'CJS stub type wrong')

// ---------------------------------------------------------------------------
// 4. Declaration files present for main entry
// ---------------------------------------------------------------------------

assert.ok(fs.existsSync(path.join(root, 'dist/commonjs/index.d.ts')), 'index.d.ts missing')
assert.ok(fs.existsSync(path.join(root, 'dist/esm/index.d.ts')), 'esm/index.d.ts missing')

// ---------------------------------------------------------------------------
// 5. CJS output uses require() — no bare ESM syntax
// ---------------------------------------------------------------------------

const indexSrc = fs.readFileSync(path.join(root, 'dist/commonjs/index.js'), 'utf8')
assert.ok(!indexSrc.match(/^import\s/m), 'CJS index.js contains bare import statement')
assert.ok(!indexSrc.match(/^export\s/m), 'CJS index.js contains bare export statement')
assert.ok(indexSrc.includes('require('), 'CJS index.js missing require()')

// ---------------------------------------------------------------------------
// 6. Imperative DI resolution
// ---------------------------------------------------------------------------

async function testDiCaf() {
  const { DiCaf } = main

  // value binding
  const kGreet = Symbol('greet')
  const di1 = new DiCaf()
  di1.bind(kGreet).toValue('hello')
  await di1.init()
  assert.equal(di1.get(kGreet), 'hello', 'toValue binding failed')

  // class binding
  const kSvc = Symbol('svc')
  class Svc { }

  const di2 = new DiCaf()
  di2.bind(kSvc).toClass(Svc)
  await di2.init()
  assert.ok(di2.get(kSvc) instanceof Svc, 'toClass binding failed')

  // factory binding
  const kFactory = Symbol('factory')
  const di3 = new DiCaf()
  di3.bind(kFactory).toFactory(() => ({ built: true }))
  await di3.init()
  assert.deepEqual(di3.get(kFactory), { built: true }, 'toFactory binding failed')

  // multiple bindings, dependency chain
  const kA = Symbol('a')
  const kB = Symbol('b')
  class A { }
  class B {
    constructor(a) {
      this.a = a
    }
  }

  const di4 = new DiCaf()
  di4.bind(kA).toClass(A)
  di4.bind(kB).toFactory(({ container }) => new B(container.get(kA)))
  await di4.init()
  const b = di4.get(kB)
  assert.ok(b instanceof B, 'factory dep chain: B not instance of B')
  assert.ok(b.a instanceof A, 'factory dep chain: b.a not instance of A')
}

// ---------------------------------------------------------------------------
// 7. Scopes enum values are symbols
// ---------------------------------------------------------------------------

function testScopes() {
  const { Scopes } = main
  assert.equal(typeof Scopes.SINGLETON, 'symbol', 'Scopes.SINGLETON not a symbol')
  assert.equal(typeof Scopes.TRANSIENT, 'symbol', 'Scopes.TRANSIENT not a symbol')
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

testScopes()
testDiCaf()
  .then(() => console.log('CJS validation: all checks passed'))
  .catch(err => {
    console.error('CJS validation failed:', err.message)
    process.exit(1)
  })
