import { afterEach, describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateModuleGraph } from './module_graph_generator.js'

// Fixtures must import the decorator: the generator only provides a class whose decorator
// resolves to the Caffeine package that exports it.
const DI = "import { Injectable } from '@caffeinejs/di'\n"

function tempDir(): string {
  return join(tmpdir(), `caffeine-test-${randomUUID()}`)
}

describe('generateModuleGraph()', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true })
    }
  })

  async function writeTree(root: string, files: Record<string, string>): Promise<void> {
    for (const [rel, text] of Object.entries(files)) {
      const abs = join(root, rel)
      await mkdir(join(abs, '..'), { recursive: true })
      await Bun.write(abs, text)
    }
  }

  it('emits per-folder generated modules, app, and a provides-only root', async () => {
    const dir = tempDir()
    dirs.push(dir)

    await writeTree(dir, {
      'src/app.ts': `${DI}@Injectable()\nexport class App {}\n`,
      'src/app.di.ts': `${DI}@Injectable()\nexport class AppDi {}\n`,
      'src/orders/order.service.ts': `${DI}import { User } from '../users/user.service.js'\n@Injectable()\nexport class OrderService { constructor(private user: User) {} }\n`,
      'src/users/user.service.ts': `${DI}@Injectable()\nexport class User {}\n`,
      'src/libs/db/client.ts': `${DI}@Injectable()\nexport class Db {}\n`,
      'src/libs/cache/cache.ts': `${DI}@Injectable()\nexport class Cache {}\n`,
      'src/libs/util.ts': `${DI}@Injectable()\nexport class Util {}\n`,
      'src/vendor/skip.ts': `${DI}@Injectable()\nexport class Skip {}\n`,
      'src/orders/orders.mod.ts': "export const extraOrdersModule = { name: 'extra' }\n",
    })

    const result = await generateModuleGraph({
      cwd: dir,
      config: {
        include: ['src/**/*.ts'],
        exclude: ['**/app.di.ts'],
        root: 'src',
        depths: { libs: 2 },
        skip: ['vendor'],
        maxDepth: 8,
      },
    })

    expect(result.changed).toBe(true)
    expect(result.modules).toBe(5)

    const orders = await Bun.file(join(dir, 'src/orders/orders.gen.mod.ts')).text()
    const users = await Bun.file(join(dir, 'src/users/users.gen.mod.ts')).text()
    const db = await Bun.file(join(dir, 'src/libs/db/db.gen.mod.ts')).text()
    const cache = await Bun.file(join(dir, 'src/libs/cache/cache.gen.mod.ts')).text()
    const app = await Bun.file(join(dir, 'src/app.gen.mod.ts')).text()
    const root = await Bun.file(join(dir, 'src/root.gen.mod.ts')).text()

    expect(await Bun.file(join(dir, 'src/libs/libs.gen.mod.ts')).exists()).toBe(false)
    expect(await Bun.file(join(dir, 'src/orders/orders.mod.ts')).text()).toContain('extraOrdersModule')

    expect(orders).toContain("import { OrderService } from './order.service.js'")
    expect(orders).not.toContain("import './order.service.js'")
    expect(orders).toContain("import { usersModule } from '../users/users.gen.mod.js'")
    expect(orders).toContain("import { extraOrdersModule } from './orders.mod.js'")
    expect(orders.indexOf("'../users/users.gen.mod.js'")).toBeLessThan(orders.indexOf("'./order.service.js'"))
    expect(orders.indexOf("'./order.service.js'")).toBeLessThan(orders.indexOf("'./orders.mod.js'"))
    expect(orders).toContain(['  needs: () => [', '    usersModule,', '    extraOrdersModule,', '  ],'].join('\n'))
    expect(orders).toContain(['  provides: () => [', '    OrderService,', '  ],'].join('\n'))
    expect(orders).toContain("name: 'orders'")

    expect(users).toContain("import { User } from './user.service.js'")
    expect(users).toContain(['  provides: () => [', '    User,', '  ],'].join('\n'))
    expect(users).not.toContain('needs:')

    expect(db).toContain("name: 'db'")
    expect(db).toContain("import { Db } from './client.js'")
    expect(cache).toContain("name: 'cache'")
    expect(cache).toContain("import { Cache } from './cache.js'")

    expect(app).toContain("import { App } from './app.js'")
    expect(app).toContain("import { Util } from './libs/util.js'")
    expect(app).not.toContain('app.di')
    expect(app).toContain(['  provides: () => [', '    App,', '    Util,', '  ],'].join('\n'))
    expect(app).toContain("name: 'app'")

    expect(root).toContain("name: 'root'")
    expect(root).toContain(
      [
        '  provides: () => [',
        '    appModule,',
        '    cacheModule,',
        '    dbModule,',
        '    ordersModule,',
        '    usersModule,',
        '  ],',
      ].join('\n'),
    )
    expect(root).not.toContain('needs:')
    expect(root).toContain('appModule')
    expect(root).toContain('ordersModule')
    expect(root).toContain('usersModule')
    expect(root).toContain('dbModule')
    expect(root).toContain('cacheModule')
    expect(root).not.toContain('Skip')
    expect(root).toContain('// AUTO-GENERATED by @caffeinejs/cli')
  })

  it('does not overwrite handwritten *.mod.ts', async () => {
    const dir = tempDir()
    dirs.push(dir)
    const handwritten = "export const ordersModule = { name: 'hand' }\n"
    await writeTree(dir, {
      'src/orders/order.service.ts': `${DI}@Injectable()\nexport class OrderService {}\n`,
      'src/orders/orders.mod.ts': handwritten,
    })

    await generateModuleGraph({
      cwd: dir,
      config: { include: ['src/**/*.ts'], root: 'src' },
    })

    expect(await Bun.file(join(dir, 'src/orders/orders.mod.ts')).text()).toBe(handwritten)
    expect(await Bun.file(join(dir, 'src/orders/orders.gen.mod.ts')).exists()).toBe(true)
  })

  it('warns and skips a decorated class that has no named export', async () => {
    const dir = tempDir()
    dirs.push(dir)
    await writeTree(dir, {
      'src/orders/order.service.ts': `${DI}@Injectable()\nexport class OrderService {}\n`,
      'src/orders/hidden.ts': `${DI}@Injectable()\nclass Hidden {}\nvoid [Hidden]\n`,
    })

    const warnings: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))
    try {
      await generateModuleGraph({ cwd: dir, config: { include: ['src/**/*.ts'], root: 'src' } })
    } finally {
      console.warn = warn
    }

    expect(warnings).toEqual([
      '[caffeine] skipped decorated class "Hidden" in "src/orders/hidden.ts": it is not exported',
    ])

    const orders = await Bun.file(join(dir, 'src/orders/orders.gen.mod.ts')).text()
    expect(orders).toContain(['  provides: () => [', '    OrderService,', '  ],'].join('\n'))
    expect(orders).not.toContain('Hidden')
    expect(orders).not.toContain('./hidden.js')
  })

  // The reason this check exists: an entity is built by the data source and its file may be compiled by a
  // separate project, so importing it from a generated module breaks the build it was kept out of.
  it('provides only classes whose decorator comes from a Caffeine package', async () => {
    const dir = tempDir()
    dirs.push(dir)
    await writeTree(dir, {
      'src/orders/order.controller.ts':
        "import { Controller } from '@caffeinejs/http'\n@Controller('/orders')\nexport class OrderController {}\n",
      'src/orders/order.entity.ts':
        "import { Entity } from 'typeorm'\n@Entity('orders')\nexport class OrderEntity {}\n",
    })

    const warnings: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))
    try {
      await generateModuleGraph({ cwd: dir, config: { include: ['src/**/*.ts'], root: 'src' } })
    } finally {
      console.warn = warn
    }

    expect(warnings).toEqual([])

    const orders = await Bun.file(join(dir, 'src/orders/orders.gen.mod.ts')).text()
    expect(orders).toContain(['  provides: () => [', '    OrderController,', '  ],'].join('\n'))
    expect(orders).not.toContain('OrderEntity')
    expect(orders).not.toContain('./order.entity.js')
  })

  it('warns when a registering decorator name does not come from its Caffeine package', async () => {
    const dir = tempDir()
    dirs.push(dir)
    await writeTree(dir, {
      'src/orders/order.service.ts': `${DI}@Injectable()\nexport class OrderService {}\n`,
      'src/orders/local.ts': "import { Injectable } from './decorators.js'\n@Injectable()\nexport class Local {}\n",
    })

    const warnings: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))
    try {
      await generateModuleGraph({ cwd: dir, config: { include: ['src/**/*.ts'], root: 'src' } })
    } finally {
      console.warn = warn
    }

    expect(warnings).toEqual([
      '[caffeine] skipped decorated class "Local" in "src/orders/local.ts": "@Injectable" is not imported from a Caffeine package',
    ])
    expect(await Bun.file(join(dir, 'src/orders/orders.gen.mod.ts')).text()).not.toContain('Local')
  })

  it('drops files deeper than maxDepth', async () => {
    const dir = tempDir()
    dirs.push(dir)
    await writeTree(dir, {
      'src/orders/order.ts': `${DI}@Injectable()\nexport class Order {}\n`,
      'src/a/b/c/d/deep.ts': `${DI}@Injectable()\nexport class Deep {}\n`,
    })

    await generateModuleGraph({
      cwd: dir,
      config: { include: ['src/**/*.ts'], root: 'src', maxDepth: 1 },
    })

    expect(await Bun.file(join(dir, 'src/orders/orders.gen.mod.ts')).exists()).toBe(true)
    expect(await Bun.file(join(dir, 'src/a/a.gen.mod.ts')).exists()).toBe(false)
    const root = await Bun.file(join(dir, 'src/root.gen.mod.ts')).text()
    expect(root).not.toContain('deep')
  })

  it('applies moduleName to the name field only', async () => {
    const dir = tempDir()
    dirs.push(dir)
    await writeTree(dir, {
      'src/orders/order.ts': `${DI}@Injectable()\nexport class Order {}\n`,
    })

    await generateModuleGraph({
      cwd: dir,
      config: {
        include: ['src/**/*.ts'],
        root: 'src',
        moduleName: name => name.toUpperCase(),
      },
    })

    const orders = await Bun.file(join(dir, 'src/orders/orders.gen.mod.ts')).text()
    expect(orders).toContain("name: 'ORDERS'")
    expect(orders).toContain('export const ordersModule')
  })

  it('returns false when content is unchanged', async () => {
    const dir = tempDir()
    dirs.push(dir)
    await writeTree(dir, {
      'src/orders/order.ts': `${DI}@Injectable()\nexport class Order {}\n`,
    })
    const config = { include: ['src/**/*.ts'], root: 'src' as const }
    await generateModuleGraph({ cwd: dir, config })
    const again = await generateModuleGraph({ cwd: dir, config })
    expect(again.changed).toBe(false)
  })

  it('tracks a cross-bucket dependency imported through a tsconfig path alias', async () => {
    const dir = tempDir()
    dirs.push(dir)
    await writeTree(dir, {
      'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/app/*'] } } }),
      'src/app/user.service.ts': `${DI}@Injectable()\nexport class User {}\n`,
      'src/orders/order.service.ts': `${DI}import { User } from '@app/user.service.js'\n@Injectable()\nexport class OrderService { constructor(private user: User) {} }\n`,
    })

    await generateModuleGraph({ cwd: dir, config: { include: ['src/**/*.ts'], root: 'src' } })

    const orders = await Bun.file(join(dir, 'src/orders/orders.gen.mod.ts')).text()
    expect(orders).toContain(['  needs: () => [', '    appModule,', '  ],'].join('\n'))
    // The generated import is still a relative path — the alias never leaks into the output.
    expect(orders).toContain("import { OrderService } from './order.service.js'")
    expect(orders).not.toContain('@app/')
  })

  it('behaves as before when no tsconfig is present', async () => {
    const dir = tempDir()
    dirs.push(dir)
    await writeTree(dir, {
      'src/app/user.service.ts': `${DI}@Injectable()\nexport class User {}\n`,
      'src/orders/order.service.ts': `${DI}import { User } from '@app/user.service.js'\n@Injectable()\nexport class OrderService {}\n`,
    })

    await generateModuleGraph({ cwd: dir, config: { include: ['src/**/*.ts'], root: 'src' } })

    const orders = await Bun.file(join(dir, 'src/orders/orders.gen.mod.ts')).text()
    expect(orders).not.toContain('needs:')
  })
})
