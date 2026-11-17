import { CaffeineIoC } from '@caffeinejs/di'
import { createWebApplication } from '@caffeinejs/http'
import { node } from '@caffeinejs/http/node'

import { rootModule } from './root.gen.mod.js'

const container = new CaffeineIoC({ modules: [rootModule] })
const app = createWebApplication({ adapter: node(), container })
await app.run({ port: 3000, host: '0.0.0.0' })
