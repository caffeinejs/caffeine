import { $cond, type Condition } from '../conditional.js'
import { CaffeineIoC } from '../container.js'
import { Conditional } from '../decorators/conditional.js'
import { Injectable } from '../decorators/injectable.js'

/**
 * `@Conditional` and `.conditional()` take conditions, or a callback handed `$cond`, and nothing else: the predicates
 * they used to take must stop compiling, and a `config` test is typed by the configuration it reads. Nothing at run
 * time can fail when those types drift, so this file is what holds them: `npm run test:typecheck` is the test.
 */

type AppConfig = { cache: { enabled: boolean; ttl: number } }

declare class RedisClient {
  ping(): void
}

const condition: Condition = $cond.env('REDIS_URL')

@Conditional(condition)
@Conditional([$cond.missing(RedisClient), $cond.env('REGION', 'eu')])
@Conditional(c => c.present(RedisClient))
@Conditional(c => [c.missing(RedisClient), c.env('REGION')])
@Injectable()
class EveryForm {}

// The type argument types the test the callback writes.
@Conditional<AppConfig>(c => c.config(cfg => cfg.cache.enabled))
@Injectable()
class TypedByTheDecorator {}

// Or the helper names it.
@Conditional($cond.config<AppConfig>(cfg => cfg.cache.ttl > 0))
@Injectable()
class TypedByTheHelper {}

// @ts-expect-error without a type argument the configuration is unknown
@Conditional(c => c.config(cfg => cfg.cache.enabled))
@Injectable()
class Untyped {}

// @ts-expect-error a test returns a boolean
@Conditional<AppConfig>(c => c.config(cfg => cfg.cache.ttl))
@Injectable()
class NumberTest {}

// @ts-expect-error a callback is handed $cond, which has no container: predicates are gone
@Conditional(ctx => ctx.container.has(RedisClient))
@Injectable()
class OldPredicate {}

// @ts-expect-error a callback returns conditions, not a boolean
@Conditional(() => true)
@Injectable()
class BooleanCallback {}

// @ts-expect-error an async callback returns a promise, not conditions
@Conditional(async c => c.present(RedisClient))
@Injectable()
class AsyncCallback {}

// @ts-expect-error a config test is synchronous
@Conditional<AppConfig>(c => c.config(async cfg => cfg.cache.enabled))
@Injectable()
class AsyncTest {}

const di = new CaffeineIoC()
di.bind(RedisClient, t => t.toSelf().conditional(c => c.env('REDIS_URL')))
di.bind(RedisClient, t => t.toSelf().conditional<AppConfig>(c => c.config(cfg => cfg.cache.enabled)))
di.bind(RedisClient, t => t.toSelf().conditional([condition, $cond.missing(RedisClient)]))
// @ts-expect-error .conditional() takes no predicate either
di.bind(RedisClient, t => t.toSelf().conditional(ctx => ctx.container.has(RedisClient)))

void [EveryForm, TypedByTheDecorator, TypedByTheHelper, Untyped, NumberTest, OldPredicate, BooleanCallback]
void [AsyncCallback, AsyncTest]
