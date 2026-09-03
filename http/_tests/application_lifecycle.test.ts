import { OnApplicationReady, OnApplicationRun, OnApplicationShutdown, OnPreApplicationShutdown } from '@caffeinejs/std'
import fastify from 'fastify'
import { describe, it, expect } from 'vitest'

import { Controller, Get, createWebApplication, fastifyAdapterFactory } from '../index.js'

describe('WebApplication lifecycle hooks', () => {
  it('fires decorator hooks and programmatic listeners around ready/run/close', async () => {
    const order: string[] = []

    @Controller('/app-lifecycle')
    class AppLifecycleController {
      @Get('/ping')
      ping() {
        return {}
      }

      @OnApplicationReady()
      onReady() {
        order.push('ready')
      }

      @OnApplicationRun()
      onRun() {
        order.push('run')
      }

      @OnPreApplicationShutdown()
      onPre() {
        order.push('pre')
      }

      @OnApplicationShutdown()
      onDown() {
        order.push('down')
      }
    }

    void [AppLifecycleController]

    const app = createWebApplication(fastifyAdapterFactory(fastify())).build()
    app.on('application:ready', () => {
      order.push('listener:ready')
    })

    await app.ready()
    expect(order).toEqual(['ready', 'listener:ready'])

    await app.run()
    expect(order).toEqual(['ready', 'listener:ready', 'run'])

    await app.close()
    expect(order).toEqual(['ready', 'listener:ready', 'run', 'pre', 'down'])
  })
})
