export const port = Number.parseInt(process.env.PORT ?? '', 10) || 3100
export const concurrency = Number.parseInt(process.env.CONCURRENCY ?? '', 10) || 100

export const baseURL = `http://localhost:${port}`

export const benchId = 'identifier'
export const benchFilter = 'some filter parameter'
export const benchQuery = new URLSearchParams({ filter: benchFilter }).toString()
export const benchPath = `/${benchId}?${benchQuery}`

export const jsonHeaders = { 'content-type': 'application/json' } as const

export const benchBody = {
  id: 100,
  name: 'bench',
  context: 'benchmark-test',
  active: true,
} as const
