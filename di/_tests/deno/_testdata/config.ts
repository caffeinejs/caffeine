import { Configuration, Provides } from '@caffeinejs/di'

export const kDenoMessage = Symbol('kDenoMessage')

@Configuration()
export class DenoAutoloadConfig {
  @Provides(kDenoMessage)
  message(): string {
    return 'deno-config-message'
  }
}
