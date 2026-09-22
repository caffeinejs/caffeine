/** One fixed list of products, the same in every fixture: about 16 KB once serialized. */
export interface Product {
  id: number
  sku: string
  name: string
  description: string
  price: number
  stock: number
  rating: number
  tags: string[]
  updatedAt: string
}

const KINDS = ['coffee', 'tea', 'grinder', 'kettle', 'filter']
const ORIGINS = ['Brazil', 'Colombia', 'Ethiopia', 'Kenya', 'Guatemala']

// Index-derived, so every process builds the same list and a test can compare against it.
export const PRODUCTS: readonly Product[] = Array.from({ length: 100 }, (_, i) => {
  const n = i + 1
  const kind = KINDS[i % KINDS.length]
  const origin = ORIGINS[(i * 3) % ORIGINS.length]

  return {
    id: n,
    sku: `P-${String(n).padStart(5, '0')}`,
    name: `${origin} ${kind} ${n}`,
    description: `Lot ${n}, ${origin}`,
    price: Number((4.5 + (i % 37) * 1.25).toFixed(2)),
    stock: (i * 7) % 250,
    rating: Number((3 + (i % 5) * 0.4).toFixed(1)),
    tags: [kind, i % 2 === 0 ? 'organic' : 'fair-trade'],
    updatedAt: '2026-09-22',
  }
})

/** How long a cached answer stays fresh, in seconds, on both sides. */
export const TTL_SECONDS = 60
