import { Configuration, Provides, token } from '@caffeinejs/di'

export const kDenoMessage = token<string>(Symbol('kDenoMessage'))

@Configuration()
export class DenoAutoloadConfig {
  @Provides(kDenoMessage)
  message(): string {
    return 'deno-config-message'
  }
}
