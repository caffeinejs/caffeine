/** Whether a request signal was aborted by Fastify's handler timeout, rather than by the client leaving. */
export function isHandlerTimeout(reason: unknown): boolean {
  return (reason as { code?: unknown } | null)?.code === 'FST_ERR_HANDLER_TIMEOUT'
}
