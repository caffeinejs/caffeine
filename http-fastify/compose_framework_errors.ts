import { FastifyError, FastifyReply, FastifyRequest } from 'fastify'

export type FrameworkErrorHandler = (
  error: FastifyError,
  req: FastifyRequest,
  res: FastifyReply,
  next: () => void,
) => void

export function composeFrameworkErrors(
  ...handlers: FrameworkErrorHandler[]
): (error: FastifyError, req: FastifyRequest, res: FastifyReply) => void {
  return function (error, req, res) {
    let index = 0

    function next() {
      if (index >= handlers.length) {
        throw error
      }
      const handler = handlers[index++]
      handler(error, req, res, next)
    }

    next()
  }
}
