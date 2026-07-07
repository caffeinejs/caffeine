const kRoot = Symbol('@caffeinejs.fetchy.root')

export class RootDescriptor {
  #methods: Map<string | symbol, MethodDescriptor>

  constructor() {
    this.#methods = new Map()
  }

  describeMethod(ctx: ClassMethodDecoratorContext, method: string | symbol): MethodDescriptor {
    let descriptor = this.#methods.get(method)
    if (!descriptor) {
      descriptor = new MethodDescriptor()
      ctx.addInitializer(function (this: any) {
        this[ctx.name] = this[ctx.name].bind(this)
      })
      this.#methods.set(method, descriptor)
    }

    return descriptor
  }
}

export class MethodDescriptor {
  #method!: string
  #path!: string
  #header!: Headers
  #handler!: (...args: unknown[]) => unknown

  handler(handler: (...args: unknown[]) => unknown): MethodDescriptor {
    this.#handler = handler
    return this
  }

  method(method: string): MethodDescriptor {
    this.#method = method
    return this
  }

  path(path: string): MethodDescriptor {
    this.#path = path
    return this
  }

  header(key: string, value: string): MethodDescriptor {
    this.#header ??= new Headers()
    this.#header.append(key, value)
    return this
  }

  to() {
    return {
      method: this.#method,
      path: this.#path,
      headers: this.#header,
      handler: this.#handler,
    }
  }
}

export function describeRequest(
  ctx: ClassMethodDecoratorContext,
  descriptor: (descriptor: MethodDescriptor) => void,
): void {
  if (ctx.kind !== 'method') {
    throw new Error('describeRequest can only be used on methods')
  }

  if (ctx.private) {
    throw new Error('describeRequest can only be used on public methods')
  }

  let root = ctx.metadata[kRoot] as RootDescriptor | undefined
  if (!root) {
    root = new RootDescriptor()
    ctx.metadata[kRoot] = root
  }

  descriptor(root.describeMethod(ctx, ctx.name))
}

export type ParameterDescriptor = {
  index: number
  key: string
  type: string
}

export type ParameterHandler = (request: RequestInit, value: unknown) => unknown

export type ParameterMapper = (argv: unknown[]) => RequestInit

function parameterMapper(): ParameterMapper {
  return argv => {
    return {
      method: 'GET',
      url: 'https://example.com',
      headers: {
        'Content-Type': 'application/json',
      },
    }
  }
}
