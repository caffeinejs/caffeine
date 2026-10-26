import { ErrCaffeineWebApplication } from '@caffeinejs/http'
import { errMessage } from '@caffeinejs/std/err'

/** The devtools answered a resource the UI read with anything but `200`. The UI renders it as a page of its own. */
export class ErrDevToolsAnswered extends ErrCaffeineWebApplication {
  constructor(
    readonly status: number,
    readonly statusText: string,
  ) {
    super(
      errMessage(`Cannot read the devtools: they answered ${status} ${statusText}`)
        .reference('@caffeinejs/devtools-ui', ErrDevToolsAnswered)
        .build(),
      'ERR_DEVTOOLS_ANSWERED',
    )
    this.name = 'ErrDevToolsAnswered'
  }
}
