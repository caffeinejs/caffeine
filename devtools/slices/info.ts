import { Router } from '@caffeinejs/http'

import type { DevToolsSlice } from '../slice.js'
import type { DevToolsInfoReport } from '../wire.js'

/**
 * Who the application is and the process it runs in, `GET <path>/info`: its name from `caffeine.name`, its active
 * profiles, the Node.js version and platform, the process id, uptime and memory.
 */
export function info(): DevToolsSlice {
  return {
    id: 'info',
    router: ({ name, store }) =>
      new Router().get('/', (): DevToolsInfoReport => {
        const { rss, heapTotal, heapUsed, external, arrayBuffers } = process.memoryUsage()

        return {
          name,
          profiles: [...store.profiles],
          node: process.version,
          platform: process.platform,
          pid: process.pid,
          uptime: process.uptime(),
          memory: { rss, heapTotal, heapUsed, external, arrayBuffers },
        }
      }),
  }
}
