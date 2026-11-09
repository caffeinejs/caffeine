import type { RedisLockClient } from '@caffeinejs/distlock/backend/redis'

// The resource a lock protects, as a fencing-aware store keeps it: it takes a write only from a token no lower than
// the last one it accepted, or equal to it from the same holder, and keeps the token with the value in one
// atomic step.
const WRITE = `if tonumber(redis.call('get', KEYS[1]) or '0') <= tonumber(ARGV[1]) then
  redis.call('set', KEYS[1], ARGV[1])
  redis.call('set', KEYS[2], ARGV[2])
  return 1
end
return 0`

function keys(resource: string): string[] {
  // Apart from the lock backend's own `{key}:fence`, so the resource proves what it accepted, not what the lock issued.
  return [`{${resource}}:resource:token`, `{${resource}}:resource:value`]
}

/** Writes `value` to `resource` under `fencingToken`, and says whether the resource took it. */
export async function fencedWrite(
  client: RedisLockClient,
  resource: string,
  fencingToken: number,
  value: string,
): Promise<boolean> {
  return (await client.eval(WRITE, { keys: keys(resource), arguments: [String(fencingToken), value] })) === 1
}

/** The keys a resource keeps its last accepted token and value under, for a spec to read with its own client. */
export function resourceKeys(resource: string): { fence: string; value: string } {
  const [fence, value] = keys(resource)
  return { fence, value }
}
