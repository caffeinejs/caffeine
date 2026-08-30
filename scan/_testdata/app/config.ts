import { Configuration, Provides, token } from '@caffeinejs/di'

export const kAppMessage = token<string>(Symbol('kAppMessage'))

@Configuration()
export class AppConfig {
  @Provides(kAppMessage)
  message(): string {
    return 'autoload-app'
  }
}
