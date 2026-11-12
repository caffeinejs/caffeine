import type { ParameterPickOptions } from '@caffeinejs/application/framework'

type Picker<REQ, RES> = (req: REQ, res: RES) => unknown

/** What one built-in pick reads off the request a route was compiled against. */
export type BasePicker<REQ, RES> = (p: ParameterPickOptions<REQ>) => (req: REQ, res: RES) => unknown

// Compiles the parameter pickers into a function that returns the handler's argument list. Unlike
// compileHandler, it does not bake in the target function — the caller resolves the instance and
// invokes the method itself, so the same instance can be reused (e.g. for per-controller error
// handling of transient-scoped controllers).
export function compileArgsWith<REQ, RES>(
  params: ParameterPickOptions<REQ>[],
  base: BasePicker<REQ, RES>,
): (req: REQ, res: RES) => unknown[] | Promise<unknown[]> {
  if (params.length === 0) {
    return () => []
  }

  const a = params.map(p => buildPicker(p, base))
  const hasAsync = params.some(p => p.async === true)

  return hasAsync ? (req, res) => Promise.all(a.map(p => p(req, res))) : (req, res) => a.map(p => p(req, res))
}

export function compileHandlerWith<REQ, RES>(
  params: ParameterPickOptions<REQ>[],
  fn: (...args: unknown[]) => unknown,
  base: BasePicker<REQ, RES>,
): (req: REQ, res: RES) => unknown {
  // Fast-path: route method has no parameters, just call the function directly
  if (params.length === 0) {
    return () => fn()
  }

  const a = params.map(p => buildPicker(p, base))
  const hasAsync = params.some(p => p.async === true)

  // Arity-based compilation for up to 6 parameters.
  // 6 parameters should account for many of the usual use cases.
  // Example:
  // [context, signal, path_params, query, header, body].

  if (!hasAsync) {
    switch (a.length) {
      case 1:
        return (req, res) => fn(a[0](req, res))
      case 2:
        return (req, res) => fn(a[0](req, res), a[1](req, res))
      case 3:
        return (req, res) => fn(a[0](req, res), a[1](req, res), a[2](req, res))
      case 4:
        return (req, res) => fn(a[0](req, res), a[1](req, res), a[2](req, res), a[3](req, res))
      case 5:
        return (req, res) => fn(a[0](req, res), a[1](req, res), a[2](req, res), a[3](req, res), a[4](req, res))
      case 6:
        return (req, res) =>
          fn(a[0](req, res), a[1](req, res), a[2](req, res), a[3](req, res), a[4](req, res), a[5](req, res))
      default: {
        const len = a.length
        return (req, res) => {
          const out = new Array(len)
          for (let i = 0; i < len; i++) {
            out[i] = a[i](req, res)
          }
          return fn(...out)
        }
      }
    }
  }

  switch (a.length) {
    case 1:
      return (req, res) => Promise.all([a[0](req, res)]).then(r => fn(r[0]))
    case 2:
      return (req, res) => Promise.all([a[0](req, res), a[1](req, res)]).then(r => fn(r[0], r[1]))
    case 3:
      return (req, res) => Promise.all([a[0](req, res), a[1](req, res), a[2](req, res)]).then(r => fn(r[0], r[1], r[2]))
    case 4:
      return (req, res) =>
        Promise.all([a[0](req, res), a[1](req, res), a[2](req, res), a[3](req, res)]).then(r =>
          fn(r[0], r[1], r[2], r[3]),
        )
    case 5:
      return (req, res) =>
        Promise.all([a[0](req, res), a[1](req, res), a[2](req, res), a[3](req, res), a[4](req, res)]).then(r =>
          fn(r[0], r[1], r[2], r[3], r[4]),
        )
    case 6:
      return (req, res) =>
        Promise.all([
          a[0](req, res),
          a[1](req, res),
          a[2](req, res),
          a[3](req, res),
          a[4](req, res),
          a[5](req, res),
        ]).then(r => fn(r[0], r[1], r[2], r[3], r[4], r[5]))
    default: {
      const len = a.length
      return (req, res) => {
        const out = new Array(len)
        for (let i = 0; i < len; i++) {
          out[i] = a[i](req, res)
        }
        return Promise.all(out).then(args => fn(...args))
      }
    }
  }
}

function buildPicker<REQ, RES>(p: ParameterPickOptions<REQ>, base: BasePicker<REQ, RES>): Picker<REQ, RES> {
  const picked = buildOne(p, base)
  const transform = p.transform
  if (transform === undefined) {
    return picked
  }

  // An async pick settles before the transform sees it, so a transform is written against the value and
  // never against a promise, whichever pick it was wrapped around.
  return p.async === true
    ? (req, res) => Promise.resolve(picked(req, res)).then(transform)
    : (req, res) => transform(picked(req, res))
}

function buildOne<REQ, RES>(p: ParameterPickOptions<REQ>, base: BasePicker<REQ, RES>): Picker<REQ, RES> {
  if (p.picker) {
    return req => (p.picker as (req: REQ) => unknown)(req)
  }

  return base(p)
}
