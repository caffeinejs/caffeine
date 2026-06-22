import { Redis } from 'ioredis'
import { Injectable } from '@caffeinejs/core/decorators'
import type { Cat } from './cat.js'

const TTL_SECONDS = 60

@Injectable([Redis])
export class CatsCache {
  constructor(private readonly redis: Redis) {}

  async get(id: number): Promise<Cat | undefined> {
    const data = await this.redis.get(`cat:${id}`)
    return data ? (JSON.parse(data) as Cat) : undefined
  }

  async set(id: number, cat: Cat): Promise<void> {
    await this.redis.set(`cat:${id}`, JSON.stringify(cat), 'EX', TTL_SECONDS)
  }

  async del(id: number): Promise<void> {
    await this.redis.del(`cat:${id}`)
  }

  async clear(): Promise<void> {
    const keys = await this.redis.keys('cat:*')
    if (keys.length > 0) {
      await this.redis.del(...keys)
    }
  }
}
