import type { IContext } from '@caffeinejs/http'

/** The form a multipart body carries, parsed as the platform parses one: what a `bodyAsBuffer()` route reads. */
export const formOf = (ctx: IContext): Promise<FormData> =>
  new Response(ctx.req.body() as Uint8Array<ArrayBuffer>, {
    headers: { 'content-type': ctx.req.header('content-type') ?? '' },
  }).formData()
