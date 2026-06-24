export interface ParameterPickOptions<R> {
  type: string
  name?: string
  picker?: ParameterPicker<R>
}

export type ParameterPicker<R, O = unknown> = (req: R) => O

export type Picker<R> = (req: R, parameters: Array<ParameterPickOptions<R>>) => ParameterPicker<R, Array<unknown>>

export function compose<R>(req: R, ...fns: Array<(req: R) => Array<unknown>>): Array<unknown> {
  return fns.reduce((acc, fn) => [...acc, ...fn(req)], [] as Array<unknown>)
}

export function param<R = unknown>(name?: string): ParameterPickOptions<R> {
  return { name, type: 'params' }
}

export function query<R = unknown>(name?: string): ParameterPickOptions<R> {
  return { name, type: 'query' }
}

export function body<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'body' }
}

export function header<R = unknown>(name?: string): ParameterPickOptions<R> {
  return { name, type: 'header' }
}

export function context<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'context' }
}

export function method<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'method' }
}

export function url<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'url' }
}

export function path<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'path' }
}

export function signal<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'signal' }
}

export function port<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'port' }
}

export function address<R = unknown>(): ParameterPickOptions<R> {
  return { type: 'address' }
}
