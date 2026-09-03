# Interceptors

- [PostResolutionInterceptor](#postresolutioninterceptor)
- [PostProcessor](#postprocessor)

---

## PostResolutionInterceptor

```ts
type PostResolutionInterceptor<T> = (ctx: ResolutionContext, instance: T) => T
```

A function that wraps a resolved instance. Runs after the instance is
constructed and `@PostConstruct` hooks have fired. Must return the (possibly
modified or replaced) instance.

Applied per-binding via `@Interceptor` or `.intercept()`:

```ts
// Decorator
@Injectable()
@Interceptor((ctx, instance) => new LoggingProxy(instance))
class PaymentService { ... }

// Fluent API
di.bind(PaymentService, t => t
  .toSelf()
  .intercept((ctx, instance) => new LoggingProxy(instance)))
```

Multiple interceptors on the same binding are chained — each receives the
output of the previous one.

---

## PostProcessor

```ts
interface PostProcessor {
  beforeInit(ctx: ResolutionContext, instance: unknown): unknown
  afterInit(ctx: ResolutionContext, instance: unknown): unknown
}
```

A global hook that runs on every non-bypassed instance in the container.
Unlike `PostResolutionInterceptor`, a `PostProcessor` is not bound to a specific
binding — it sees every instance.

Register a post-processor on the container's `postProcessors` set before
calling `init()`:

```ts
class MetricsPostProcessor implements PostProcessor {
  beforeInit(ctx: ResolutionContext, instance: unknown): unknown {
    return instance
  }

  afterInit(ctx: ResolutionContext, instance: unknown): unknown {
    if (instance instanceof Observable) {
      instance.trackMetrics()
    }
    return instance
  }
}

const di = new CaffeineIoC({ modules: [appModule] })
di.postProcessors.add(new MetricsPostProcessor())
await di.init()
```

Both `beforeInit` and `afterInit` must return the instance (or a replacement).
Bindings decorated with `@BypassPostProcessors` or configured with
`.byPassPostProcessors()` are excluded from all post-processors.
