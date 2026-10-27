#!/usr/bin/env node

import { buildApp } from './app.js'

const app = buildApp()
const { address } = await app.run()

app.log.info(`Devtools UI on ${address.origin}`)
