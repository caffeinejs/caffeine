import { parentPort } from 'node:worker_threads'
import { DiCaf } from '../container.js'
import { Injectable } from '../decorators/injectable.js'
import { Lifetime } from '../decorators/lifetime.js'
import { Scopes } from '../scope.js'
import { PostConstruct } from '../decorators/post_construct.js'

@Injectable()
@Lifetime(Scopes.SINGLETON)
class Counter {
  count = 0
  increment() {
    return ++this.count
  }
}

@Injectable()
@Lifetime(Scopes.SINGLETON)
class Greeter {
  initialized = false

  @PostConstruct()
  init() {
    this.initialized = true
  }

  greet() {
    return 'hello from worker'
  }
}

@Injectable([Counter])
class Service {
  counter: Counter
  constructor(counter: Counter) {
    this.counter = counter
  }
}

const di = new DiCaf()
await di.init()

const c1 = di.get(Counter)
const c2 = di.get(Counter)
c1.increment()
c1.increment()

const greeter = di.get(Greeter)
const service = di.get(Service)

parentPort!.postMessage({
  singletonIsSameInstance: c1 === c2,
  countAfterTwoIncrements: c2.count,
  postConstructFired: greeter.initialized,
  greeterMessage: greeter.greet(),
  injectionWorks: service.counter === c1,
})
