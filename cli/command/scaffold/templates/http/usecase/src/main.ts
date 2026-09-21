import { CaffeineIoC } from '@caffeinejs/di'
import { createWebApplication } from '@caffeinejs/http'

import { rootModule } from './root.gen.mod.js'

const container = new CaffeineIoC({ modules: [rootModule] })
const app = createWebApplication({ container })
await app.run({ port: 3000, host: '0.0.0.0' })
