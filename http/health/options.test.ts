import { describe, it, expect } from 'vitest'

import { defaultHealthOptions } from './options.js'

describe('defaultHealthOptions', () => {
  it('stays off outside an orchestrator', () => {
    const options = defaultHealthOptions({})

    expect(options.enabled).toBe(false)
    expect(options.paths).toEqual({ live: '/livez', ready: '/readyz', startup: '/startupz' })
  })

  it('turns itself on inside a pod', () => {
    expect(defaultHealthOptions({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }).enabled).toBe(true)
  })
})
