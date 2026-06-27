import { AdapterFactory } from '@caffeinejs/http'
import { Context, Hono } from 'hono'
import { HonoAdapter } from './adapter.js'

export function honoAdapterFactory<
  SERVER extends Hono = Hono,
  CTX extends Context = Context,
>(hono: SERVER): AdapterFactory<SERVER, CTX, HonoAdapter<SERVER, CTX>> {
  return (kit): HonoAdapter<SERVER, CTX> =>
    new HonoAdapter<SERVER, CTX>(kit.container, hono)
}
