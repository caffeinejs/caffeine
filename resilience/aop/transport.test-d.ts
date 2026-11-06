import { describe, it } from 'vitest'

import { ResilienceTransport } from './transport.js'

// Every class here only exists for the compiler: the file is type-checked, never run.
describe('ResilienceTransport', () => {
  // A transport that never decided which errors are its client's own would leave every one of them counted.
  it('makes a transport say which errors are its client errors', () => {
    const kService = Symbol('grpc service')

    // @ts-expect-error isClientError is required
    class Undecided extends ResilienceTransport {
      readonly label = kService
    }

    class GRPCTransport extends ResilienceTransport {
      readonly label = kService

      isClientError(error: unknown): boolean {
        return error instanceof RangeError
      }
    }

    void Undecided
    void GRPCTransport
  })
})
