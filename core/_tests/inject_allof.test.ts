import { describe, expect, it } from 'vitest'
import { Extends } from '../decorators/extends.js'
import { Injectable } from '../decorators/legacy/injectable.legacy.js'
import { Named } from '../decorators/named.js'
import { CaffeineIoC } from '../container.js'
import { allOf } from '../injection.js'

describe('given multiple named injectables sharing the same name', function () {
  describe('and one of them asking to inject all others via that shared name', function () {
    const kProcessor = Symbol('processor')

    interface Processor {
      process(): string
    }

    @Named(kProcessor)
    @Injectable()
    class ProcessorA implements Processor {
      process(): string {
        return 'ProcessorA'
      }
    }

    @Named(kProcessor)
    @Injectable()
    class ProcessorB implements Processor {
      process(): string {
        return 'ProcessorB'
      }
    }

    @Named(kProcessor)
    @Injectable([allOf(kProcessor)])
    class Root {
      constructor(readonly processors: Processor[]) {}

      process(): string {
        return this.processors.map(p => p.process())
          .join(', ')
      }
    }

    it('should inject all named implementations except the one that asked for them', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const root = di.get(Root)
      expect(root.processors)
        .toHaveLength(2)
      expect(root.processors.map(p => p.process())
        .sort())
        .toEqual(['ProcessorA', 'ProcessorB'])
    })
  })
})

describe('given multiple injectables extending the same abstract class', function () {
  describe('and an injetable also extending the abstract class but asking to inject all the others using the abstract class as key', function () {
    abstract class Processor {
      abstract process(): string
    }

    @Extends()
    class ProcessorA extends Processor {
      process(): string {
        return 'ProcessorA'
      }
    }

    @Extends()
    class ProcessorB extends Processor {
      process(): string {
        return 'ProcessorB'
      }
    }

    @Injectable([allOf(Processor)])
    @Extends()
    class Root extends Processor {
      constructor(readonly processors: Processor[]) {
        super()
      }

      process(): string {
        return this.processors.map(p => p.process())
          .join(', ')
      }
    }

    it('should inject all implementations abstract class implementations, expect the one that asked for them', async function () {
      const di = new CaffeineIoC()
      await di.init()

      const root = di.get(Root)
      expect(root.processors)
        .toHaveLength(2)
      expect(root.processors.map(p => p.process())
        .sort())
        .toEqual(['ProcessorA', 'ProcessorB'])
    })
  })
})
