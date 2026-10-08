import { errMessage } from '@caffeinejs/std/framework/err'

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
    const fixes = [`Register the binder with .use("${via}", ...) on the messaging builder`]
    if (configured.length > 0) {
      const names = configured.map(name => `"${name}"`).join(', ')
      fixes.push(`Or point the binding with via: "..." at a registered binder: ${names}`)
    }
    super(
      errMessage(`Cannot resolve binding "${binding}": no binder named "${via}" is registered`)
        .solutions(...fixes)
        .reference('@caffeinejs/messaging', ErrUnknownBinder)
        .build(),
      'ERR_UNKNOWN_BINDER',
    )
    this.name = 'ErrUnknownBinder'
  }
}

/** Thrown when a handler or a publish targets a binding name that has no registered definition. */
export class ErrUnknownBinding extends ErrMessaging {
  constructor(binding: string, kind: 'inbound' | 'outbound') {
    super(
      errMessage(`Cannot resolve ${kind} binding "${binding}": no such binding is registered`)
        .solutions(
          `Declare it on the messaging builder, for example .${kind === 'inbound' ? 'in' : 'out'}("${binding}", { destination: "...", via: "..." })`,
        )
        .reference('@caffeinejs/messaging', ErrUnknownBinding)
        .build(),
      'ERR_UNKNOWN_BINDING',
    )
    this.name = 'ErrUnknownBinding'
  }
}

/** Thrown at startup when an inbound binding is declared but no `@Consume` handler attaches to it. */
export class ErrNoConsumer extends ErrMessaging {
  constructor(binding: string) {
    super(
      errMessage(`Cannot start inbound binding "${binding}": no @Consume handler is registered for it`)
        .solutions(
          `Add a handler: @Consume("${binding}") on a @MessageHandler class`,
          'Or remove the unused inbound binding declaration',
        )
        .reference('@caffeinejs/messaging', ErrNoConsumer)
        .build(),
      'ERR_NO_CONSUMER',
    )
    this.name = 'ErrNoConsumer'
  }
}

/** Thrown when a binding is declared without a destination to map onto the broker. */
export class ErrMissingDestination extends ErrMessaging {
  constructor(binding: string) {
    super(
      errMessage(`Cannot register binding "${binding}": no destination declared`)
        .solutions('Pass a destination, for example { destination: "orders" }')
        .reference('@caffeinejs/messaging', ErrMissingDestination)
        .build(),
      'ERR_MISSING_DESTINATION',
    )
    this.name = 'ErrMissingDestination'
  }
}

/** Thrown by `MessageBus.send` when an outbound payload fails its binding's schema. Carries the issues. */
export class ErrMessageValidation extends ErrMessaging {
  readonly issues: readonly { path: string; message: string }[]

  constructor(binding: string, issues: readonly { path: string; message: string }[]) {
    const detail = issues.map(issue => `${issue.path.length > 0 ? issue.path : '(root)'}: ${issue.message}`).join('; ')
    super(
      errMessage(`Cannot publish to binding "${binding}": payload does not satisfy the schema: ${detail}`)
        .reference('@caffeinejs/messaging', ErrMessageValidation)
        .build(),
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
      errMessage(`Cannot redeliver message from "${source}": nack retries exhausted after ${attempts} attempts`)
        .reference('@caffeinejs/messaging', ErrNackExhausted)
        .build(),
      'ERR_NACK_EXHAUSTED',
    )
    this.name = 'ErrNackExhausted'
  }
}
