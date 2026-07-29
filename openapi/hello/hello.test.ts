import { describe, it, expect } from 'vitest'
import { hello } from './index.js'

describe('hello', () => {
  it('greets the world by default', () => {
    expect(hello()).toBe('hello world')
  })

  it('greets the given name', () => {
    expect(hello('caffeine')).toBe('hello caffeine')
  })
})
