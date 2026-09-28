import { describe, expect, it } from 'vitest'

import { CaffeineIoC } from '../container.js'
import { Injectable } from '../decorators/injectable.js'
import { ErrInjectableBase } from '../errors.js'

describe('@Injectable — extending an @Injectable base', function () {
  @Injectable()
  class Base {
    greet(): string {
      return 'base'
    }
  }

  @Injectable()
  class Child extends Base {
    override greet(): string {
      return 'child'
    }
  }

  void Child

  it('throws ErrInjectableBase when the container compiles — @Injectable classes cannot serve as extension bases', async function () {
    await expect(new CaffeineIoC().compile()).rejects.toThrow(ErrInjectableBase)
  })
})
