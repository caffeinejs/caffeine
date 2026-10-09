import { ErrCaffeineWebApplication } from '@caffeinejs/http'

/** What start-up refuses in the UI's configuration: an application's name, URL or credentials. */
export class ErrDevToolsUIConfiguration extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_DEVTOOLS_UI_CONFIGURATION')
    this.name = 'ErrDevToolsUIConfiguration'
  }
}
