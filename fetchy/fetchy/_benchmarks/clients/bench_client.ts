export interface BenchClient {
  name: string
  request(): Promise<unknown>
}
