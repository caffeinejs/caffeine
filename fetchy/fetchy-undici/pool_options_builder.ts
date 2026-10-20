import type { ConnectionOptions } from 'node:tls'

import type { ByteSize } from '@caffeinejs/std/bytes'
import type { Duration } from '@caffeinejs/std/duration'
import type { Dispatcher, Pool } from 'undici'

/**
 * Fluent builder for `undici.Pool.Options`.
 */
export class PoolOptionsBuilder {
  private _connections: number | undefined
  private _socketPath: string | undefined
  private _keepAliveTimeout: Duration | undefined
  private _keepAliveMaxTimeout: Duration | undefined
  private _keepAliveTimeoutThreshold: Duration | undefined
  private _pipelining: number | undefined
  private _connect: ConnectionOptions | undefined
  private _maxHeaderSize: ByteSize | undefined
  private _headersTimeout: Duration | undefined
  private _bodyTimeout: Duration | undefined
  private _factory: ((origin: URL, opts: object) => Dispatcher) | undefined

  static newBuilder(): PoolOptionsBuilder {
    return new PoolOptionsBuilder()
  }

  connections(n: number): this {
    this._connections = n
    return this
  }

  socketPath(path: string): this {
    this._socketPath = path
    return this
  }

  keepAliveTimeout(timeout: Duration): this {
    this._keepAliveTimeout = timeout
    return this
  }

  keepAliveMaxTimeout(timeout: Duration): this {
    this._keepAliveMaxTimeout = timeout
    return this
  }

  keepAliveTimeoutThreshold(threshold: Duration): this {
    this._keepAliveTimeoutThreshold = threshold
    return this
  }

  pipelining(n: number): this {
    this._pipelining = n
    return this
  }

  tls(opts: ConnectionOptions): this {
    this._connect = opts
    return this
  }

  maxHeaderSize(size: ByteSize): this {
    this._maxHeaderSize = size
    return this
  }

  headersTimeout(timeout: Duration): this {
    this._headersTimeout = timeout
    return this
  }

  bodyTimeout(timeout: Duration): this {
    this._bodyTimeout = timeout
    return this
  }

  /**
   * Builds each connection of an origin's pool, as the `factory` of a `Pool` does.
   */
  factory(f: (origin: URL, opts: object) => Dispatcher): this {
    this._factory = f
    return this
  }

  build(): Pool.Options {
    return {
      connections: this._connections,
      socketPath: this._socketPath,
      keepAliveTimeout: this._keepAliveTimeout,
      keepAliveMaxTimeout: this._keepAliveMaxTimeout,
      keepAliveTimeoutThreshold: this._keepAliveTimeoutThreshold,
      pipelining: this._pipelining,
      connect: this._connect,
      maxHeaderSize: this._maxHeaderSize,
      // undici takes these two in whole milliseconds.
      headersTimeout: this._headersTimeout === undefined ? undefined : Math.ceil(this._headersTimeout),
      bodyTimeout: this._bodyTimeout === undefined ? undefined : Math.ceil(this._bodyTimeout),
      factory: this._factory,
    }
  }
}
