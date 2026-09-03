import { $i, Configuration, Inject, Injectable, Provides, token } from '../index.js'
import type { Provider } from '../provider.js'

class Repo {
  find(): string {
    return 'row'
  }
}

class Logger {
  log(message: string): void {
    void message
  }
}

/**
 * Compile-time contract of `@Injectable` dependency lists. Never called: the assertions are the
 * `@ts-expect-error` comments, which fail the build if the error they mark stops happening.
 */
function injectableTupleTypeChecks(): void {
  @Injectable()
  class NoArgs {}

  @Injectable([Repo, Logger])
  class Ok {
    constructor(
      readonly repo: Repo,
      readonly logger: Logger,
    ) {}
  }

  // @ts-expect-error dependencies are checked by position, not as a set
  @Injectable([Logger, Repo])
  class Swapped {
    constructor(
      readonly repo: Repo,
      readonly logger: Logger,
    ) {}
  }

  // @ts-expect-error one injection for a two-parameter constructor
  @Injectable([Repo])
  class Short {
    constructor(
      readonly repo: Repo,
      readonly logger: Logger,
    ) {}
  }

  @Injectable([Repo, $i.optional(Logger)])
  class OptionalOk {
    constructor(
      readonly repo: Repo,
      readonly logger?: Logger,
    ) {}
  }

  // @ts-expect-error optional injection does not satisfy a required parameter
  @Injectable([Repo, $i.optional(Logger)])
  class OptionalOnRequired {
    constructor(
      readonly repo: Repo,
      readonly logger: Logger,
    ) {}
  }

  // @ts-expect-error a collection injection does not satisfy a single-instance parameter
  @Injectable([Repo, $i.allOf(Logger)])
  class AllOfOnSingle {
    constructor(
      readonly repo: Repo,
      readonly logger: Logger,
    ) {}
  }

  // @ts-expect-error a provider injection does not satisfy a single-instance parameter
  @Injectable([Repo, $i.provide(Logger)])
  class ProvideOnInstance {
    constructor(
      readonly repo: Repo,
      readonly logger: Logger,
    ) {}
  }

  @Injectable([Logger, $i.provide(Repo)])
  class ProvideOk {
    constructor(
      readonly logger: Logger,
      readonly repo: Provider<Repo>,
    ) {}
  }

  const kSvc = token<Ok>(Symbol('svc'))

  // @ts-expect-error the token's value type has to match the class it is attached to
  @Injectable(kSvc)
  class NamedNoArgs {}

  @Injectable(kSvc, [Repo, Logger])
  class NamedWithDeps {
    constructor(
      readonly repo: Repo,
      readonly logger: Logger,
    ) {}
  }

  void NoArgs
  void Ok
  void Swapped
  void Short
  void OptionalOk
  void OptionalOnRequired
  void AllOfOnSingle
  void ProvideOnInstance
  void ProvideOk
  void NamedNoArgs
  void NamedWithDeps
}

void injectableTupleTypeChecks

/**
 * Compile-time contract of the remaining decorator paths: `@Provides`, `@Configuration`, `@Aspect` and
 * `@Inject`. Same rules as `@Injectable` — one injection per parameter, checked by position and arity — plus
 * the key-to-member relation, which is what stops a token being attached to something it does not name.
 */
function decoratorDependencyTypeChecks(): void {
  const kMsg = token<string>(Symbol('msg'))

  @Configuration([Repo, Logger])
  class ConfOk {
    constructor(
      readonly repo: Repo,
      readonly logger: Logger,
    ) {}

    @Provides(kMsg)
    msg(): string {
      return 'hello'
    }

    @Provides(Repo, [Logger])
    repoFrom(logger: Logger): Repo {
      void logger
      return new Repo()
    }
  }

  // @ts-expect-error dependencies are checked by position: the list does not match the constructor
  @Configuration([Logger, Repo])
  class ConfSwapped {
    constructor(
      readonly repo: Repo,
      readonly logger: Logger,
    ) {}
  }

  class ProvidesMismatch {
    // @ts-expect-error the method's return type has to match the key it is provided under
    @Provides(kMsg)
    notAString(): number {
      return 1
    }
  }

  class ProvidesBadDeps {
    // @ts-expect-error one injection for a two-parameter method
    @Provides(Repo, [Logger])
    twoParams(logger: Logger, repo: Repo): Repo {
      void logger
      void repo
      return new Repo()
    }
  }

  class InjectMismatch {
    // @ts-expect-error the key's value type has to match the field it is injected into
    @Inject(kMsg)
    repo!: Repo

    @Inject(kMsg)
    msg!: string

    // @ts-expect-error one injection for a two-parameter method
    @Inject([Repo])
    setBoth(repo: Repo, logger: Logger): void {
      void repo
      void logger
    }
  }

  void ConfOk
  void ConfSwapped
  void ProvidesMismatch
  void ProvidesBadDeps
  void InjectMismatch
}

void decoratorDependencyTypeChecks
