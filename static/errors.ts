import { ErrCaffeineWebApplication } from '@caffeinejs/http'
import { errMessage } from '@caffeinejs/std/framework/err'

/**
 * ErrSendFileUnavailable is thrown when {@link sendFile} or {@link download} is called and no static mount
 * decorated the reply.
 *
 * `@fastify/static` decorates `reply.sendFile` and `reply.download` once per server, so the helpers need
 * `staticFiles(...)` installed with a mount that took the decoration.
 */
export class ErrSendFileUnavailable extends ErrCaffeineWebApplication {
  constructor(decorator: string) {
    super(
      errMessage(`Cannot send a file: "${decorator}" is not decorated on the reply`)
        .solutions(
          'Install staticFiles(...) with at least one .serve(...) mount',
          'Leave decorateReply unset on the mount whose settings these helpers should use',
        )
        .reference('@caffeinejs/static', ErrSendFileUnavailable)
        .build(),
      'ERR_SEND_FILE_UNAVAILABLE',
    )
    this.name = 'ErrSendFileUnavailable'
  }
}
