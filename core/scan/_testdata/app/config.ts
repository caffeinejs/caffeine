import { Configuration } from '../../../decorators/configuration.js'
import { Provides } from '../../../decorators/provides.js'

export const kAppMessage = Symbol('kAppMessage')

@Configuration()
export class AppConfig {
  @Provides(kAppMessage)
  message(): string {
    return 'autoload-app'
  }
}
