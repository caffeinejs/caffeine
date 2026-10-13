import { ErrCaffeineWebApplication } from '@caffeinejs/http'

/** What start-up refuses in a DevTools setup: its path, a slice's id, or its authorization declared both ways. */
export class ErrDevToolsConfiguration extends ErrCaffeineWebApplication {
  constructor(message: string) {
    super(message, 'ERR_DEVTOOLS_CONFIGURATION')
    this.name = 'ErrDevToolsConfiguration'
  }
}
