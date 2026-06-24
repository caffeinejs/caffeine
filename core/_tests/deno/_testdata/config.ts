import { Configuration, Provides } from '@caffeinejs/core/decorators'

export const kDenoMessage = Symbol('kDenoMessage')

@Configuration()
export class DenoAutoloadConfig {
  @Provides(kDenoMessage)
  message(): string {
    return 'deno-config-message'
  }
}
