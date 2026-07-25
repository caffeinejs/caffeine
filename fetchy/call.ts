export interface Call {
  execute(request: Request): Promise<Response>
}

export interface CallFactory {
  provide(baseURL: string): Call
}
