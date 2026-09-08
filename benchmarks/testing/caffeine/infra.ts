import { Injectable } from '@caffeinejs/di'

@Injectable()
export class Clock {
  now(): number {
    return Date.now()
  }
}

@Injectable()
export class AppConfig {
  readonly greeting = 'world'
}

@Injectable()
export class IdGenerator {
  next(): number {
    return 1
  }
}

@Injectable([AppConfig])
export class Logger {
  constructor(private readonly config: AppConfig) {}

  log(_message: string): void {
    void this.config.greeting
  }
}

@Injectable([Clock])
export class Metrics {
  constructor(private readonly clock: Clock) {}

  increment(_name: string): void {
    void this.clock.now()
  }
}

@Injectable([AppConfig])
export class Cache {
  readonly #store = new Map<string, string>()

  constructor(private readonly config: AppConfig) {
    this.#store.set('greeting', this.config.greeting)
  }

  get(key: string): string | undefined {
    return this.#store.get(key)
  }
}
