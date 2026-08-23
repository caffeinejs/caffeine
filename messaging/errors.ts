/** Base error for the portable messaging layer. */
export class ErrMessaging extends Error {
  readonly code: string

  constructor(message: string, code: string) {
    super(message)
    this.name = 'ErrMessaging'
    this.code = code
  }
}

/** Thrown when a binding, or a handler, references a binder instance that was never registered. */
export class ErrUnknownBinder extends ErrMessaging {
  constructor(binding: string, via: string, configured: string[]) {
    const known = configured.length > 0 ? configured.map(name => `"${name}"`).join(', ') : '(none)'
    super(
      `Cannot resolve binding "${binding}": no binder named "${via}" is registered`
      + `\n  - Register the binder with .use("${via}", ...) on the messaging builder`
      + '\n  - Or point the binding at a registered binder with via: "..."'
      + `\n  - Registered binders: ${known}`,
      'ERR_UNKNOWN_BINDER',
    )
    this.name = 'ErrUnknownBinder'
  }
}

/** Thrown when a handler or a publish targets a binding name that has no registered definition. */
export class ErrUnknownBinding extends ErrMessaging {
  constructor(binding: string, kind: 'inbound' | 'outbound') {
    super(
      `Cannot resolve ${kind} binding "${binding}": no such binding is registered`
      + `\n  - Declare it on the messaging builder, for example .${kind === 'inbound' ? 'in' : 'out'}("${binding}", { destination: "...", via: "..." })`,
      'ERR_UNKNOWN_BINDING',
    )
    this.name = 'ErrUnknownBinding'
  }
}

/** Thrown at startup when an inbound binding is declared but no `@Consume` handler attaches to it. */
export class ErrNoConsumer extends ErrMessaging {
  constructor(binding: string) {
    super(
      `Cannot start inbound binding "${binding}": no @Consume handler is registered for it`
      + `\n  - Add a handler: @Consume("${binding}") on a @MessageHandler class`
      + '\n  - Or remove the unused inbound binding declaration',
      'ERR_NO_CONSUMER',
    )
    this.name = 'ErrNoConsumer'
  }
}

/** Thrown when a binding is declared without a destination to map onto the broker. */
export class ErrMissingDestination extends ErrMessaging {
  constructor(binding: string) {
    super(
      `Cannot register binding "${binding}": no destination declared`
      + '\n  - Pass a destination, for example { destination: "orders" }',
      'ERR_MISSING_DESTINATION',
    )
    this.name = 'ErrMissingDestination'
  }
}

/** Thrown by `MessageBus.send` when an outbound payload fails its binding's schema. Carries the issues. */
export class ErrMessageValidation extends ErrMessaging {
  readonly issues: readonly { path: string, message: string }[]

  constructor(binding: string, issues: readonly { path: string, message: string }[]) {
    const detail = issues.map(issue => `${issue.path.length > 0 ? issue.path : '(root)'}: ${issue.message}`).join('; ')
    super(
      `Cannot publish to binding "${binding}": payload does not satisfy the schema: ${detail}`,
      'ERR_MESSAGE_VALIDATION',
    )
    this.name = 'ErrMessageValidation'
    this.issues = issues
  }
}

/** Passed to the recoverer when a handler kept calling `ctx.nack()` until the retry budget was exhausted. */
export class ErrNackExhausted extends ErrMessaging {
  constructor(source: string, attempts: number) {
    super(
      `Cannot redeliver message from "${source}": nack retries exhausted after ${attempts} attempts`,
      'ERR_NACK_EXHAUSTED',
    )
    this.name = 'ErrNackExhausted'
  }
}
