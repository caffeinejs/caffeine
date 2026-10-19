import { describe, expect, it } from 'vitest'

import { errMessage } from './message.js'

class ErrDemo extends Error {}

describe('errMessage', () => {
  it('returns the message unchanged when nothing is added', () => {
    // A test that matches a whole message, or anchors on its end, must keep passing for an error without solutions.
    expect(errMessage('Cannot do X: reason').build()).toBe('Cannot do X: reason')
  })

  it('prints the solutions block tools parse: a header and two-space dash bullets', () => {
    expect(errMessage('Cannot do X: reason').solutions('Do A', 'Do B').build()).toBe(
      'Cannot do X: reason\nPossible Solutions:\n  - Do A\n  - Do B',
    )
  })

  it('accumulates solutions across calls in the order given, most likely fix first', () => {
    expect(errMessage('m').solutions('first').solutions('second', 'third').build()).toBe(
      'm\nPossible Solutions:\n  - first\n  - second\n  - third',
    )
  })

  it('prints no header for an empty solutions list', () => {
    expect(errMessage('m').solutions().build()).toBe('m')
  })

  it('prints the links block after the solutions', () => {
    expect(errMessage('m').links('https://a.example', 'https://b.example').solutions('fix').build()).toBe(
      'm\nPossible Solutions:\n  - fix\nSee also:\n  - https://a.example\n  - https://b.example',
    )
  })

  it('prints no reference line while the error pages are unpublished', () => {
    // The base URL is empty until the pages exist, so a message never carries a link that leads nowhere. When it is
    // set, this case is replaced by one asserting the printed `Read more:` line.
    expect(errMessage('m').reference('@caffeinejs/std', ErrDemo).build()).toBe('m')
    expect(
      errMessage('m').reference('@caffeinejs/std', ErrDemo).solutions('fix').links('https://a.example').build(),
    ).toBe('m\nPossible Solutions:\n  - fix\nSee also:\n  - https://a.example')
  })

  it('keeps the first line as the bare message', () => {
    const built = errMessage('Cannot do X: reason').solutions('fix').links('https://a.example').build()

    expect(built.split('\n')[0]).toBe('Cannot do X: reason')
  })
})
