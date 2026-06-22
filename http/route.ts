import { Binding, Key, Provider } from '@caffeine-projects/dicaf'
import { ParameterPickOptions } from './route.picker.js'

export interface Route<R> {
  path: string
  method: string[]
  accept: string[]
  contentTypes: string[]
  parameters: ParameterPickOptions<R>[]
  header: Record<string, string | string[]>
  handler: string | symbol
  response: {
    status: number
    header: Record<string, string>
  }
}

export interface Router<R> {
  prefix: string
  routes: Route<R>[]
  accept: string[]
  contentTypes: string[]
  header: Record<string, string | string[]>
  key: Key
  binding: Binding
  controller: Provider<Record<string | symbol, (...args: unknown[]) => unknown>>
}
