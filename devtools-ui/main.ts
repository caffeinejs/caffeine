#!/usr/bin/env node
import { kConfig } from './app.config.js'
import { buildApp } from './app.js'

const app = buildApp()
const { address } = await app.run()

app.log.info(`Devtools UI on ${address.origin}, reading ${app.container.get(kConfig).target.url}`)
