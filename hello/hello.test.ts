import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Greeter, hello } from './greeter.js'

describe('hello', () => {
  it('greets the world by default', () => {
    assert.equal(hello(), 'HELLO, WORLD')
  })

  it('greets a given name', () => {
    assert.equal(hello('caffeine'), 'HELLO, CAFFEINE')
  })

  it('applies the uppercase decorator on the method', () => {
    assert.equal(new Greeter('decorators').greet(), 'HELLO, DECORATORS')
  })
})
