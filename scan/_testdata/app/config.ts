import { Configuration, Provides } from '@caffeinejs/di'

export const kAppMessage = Symbol('kAppMessage')

@Configuration()
export class AppConfig {
  @Provides(kAppMessage)
  message(): string {
    return 'autoload-app'
  }
}
