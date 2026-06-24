/**
 * Test utilities for {@link CaffeineIoC} containers.
 *
 * {@link TestContainer} is a fluent builder that takes a live container or a
 * {@link Snapshot} and produces a trimmed, override-ready container suitable for
 * use in unit and integration tests. It does not initialize the container — call
 * `await di.init()` yourself so tests control when resolution happens.
 *
 * The typical pattern is to snapshot the application container once (in a
 * `beforeAll` / `beforeEach`) and let each test suite or test case build its own
 * isolated container on top of that snapshot.
 *
 * ---
 *
 * **Suite-scoped container** — one container shared across all tests in a file:
 *
 * ```ts
 * import { beforeAll, describe, expect, it } from 'vitest'
 * import { CaffeineIoC } from '@caffeine-projects/di'
 * import { TestContainer } from '@caffeine-projects/di/testing'
 * import { mockRepo } from './mocks.js'
 *
 * describe('OrderService', () => {
 *   let di: CaffeineIoC
 *
 *   beforeAll(async () => {
 *     const source = new CaffeineIoC()
 *     di = new TestContainer(source)
 *       .override(Repository, b => b.toValue(mockRepo))
 *       .build()
 *     await di.init()
 *   })
 *
 *   it('places order', () => {
 *     expect(di.get(OrderService).place()).toBe('ok')
 *   })
 * })
 * ```
 *
 * @packageDocumentation
 * @testing
 */

export * from './testing.js'
