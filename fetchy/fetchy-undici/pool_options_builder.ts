import type { ConnectionOptions } from 'node:tls'

import type { Dispatcher, Pool } from 'undici'

/**
 * Fluent builder for `undici.Pool.Options`.
 */
export class PoolOptionsBuilder {
  private _connections: number | undefined
  private _socketPath: string | undefined
  private _keepAliveTimeout: number | undefined
  private _keepAliveMaxTimeout: number | undefined
  private _keepAliveTimeoutThreshold: number | undefined
  private _pipelining: number | undefined
  private _connect: ConnectionOptions | undefined
  private _maxHeaderSize: number | undefined
  private _headersTimeout: number | undefined
  private _bodyTimeout: number | undefined
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

  keepAliveTimeout(ms: number): this {
    this._keepAliveTimeout = ms
    return this
  }

  keepAliveMaxTimeout(ms: number): this {
    this._keepAliveMaxTimeout = ms
    return this
  }

  keepAliveTimeoutThreshold(ms: number): this {
    this._keepAliveTimeoutThreshold = ms
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

  maxHeaderSize(n: number): this {
    this._maxHeaderSize = n
    return this
  }

  headersTimeout(ms: number): this {
    this._headersTimeout = ms
    return this
  }

  bodyTimeout(ms: number): this {
    this._bodyTimeout = ms
    return this
  }

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
      headersTimeout: this._headersTimeout,
      bodyTimeout: this._bodyTimeout,
      factory: this._factory,
    }
  }
}
