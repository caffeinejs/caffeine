import { Router } from '@caffeinejs/http'

import { HelloService } from './hello.service.js'

export const hello = new Router('/hello').inject({ hello: HelloService }).get('/', (_ctx, deps) => deps.hello.greet())
