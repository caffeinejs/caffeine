import {
  CaffeineIoC,
  Conditional,
  Configuration,
  ErrRepeatedInjectableConfiguration,
  Provides,
  token,
} from '@caffeinejs/di'
import { describe, expect, it } from 'vitest'

import { TestContainer } from './test_container.js'

// Unprofiled on purpose: the snapshot a new TestContainer() takes then holds the unconditional @Provides, and
// restores it into a container that reads decorators again, where it must still meet the conditional one. The
// fixtures live in a file of their own, since every container this file builds sees them.
const kClash = token<string>(Symbol('test-container-clash'))

@Configuration()
class PlainClash {
  @Provides(kClash)
  value(): string {
    return 'plain'
  }
}

@Configuration()
@Conditional(c => c.when(() => true))
class ConditionalClash {
  @Provides(kClash)
  value(): string {
    return 'conditional'
  }
}

void [PlainClash, ConditionalClash]

describe('TestContainer and conditional clashes', function () {
  it('fails init() on the clash the container itself refuses', async function () {
    await expect(new CaffeineIoC().init()).rejects.toThrow(ErrRepeatedInjectableConfiguration)
    await expect(new TestContainer().build().init()).rejects.toThrow(ErrRepeatedInjectableConfiguration)
  })
})
