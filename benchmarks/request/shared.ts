export interface BigItem {
  id: number
  message: string
  active: boolean
  cities: string[]
}

export function makeBigArray(size = 100): BigItem[] {
  const items: BigItem[] = []
  for (let i = 1; i <= size; i++) {
    items.push({
      id: i,
      message: 'Some Very Nice Message For Testing',
      active: true,
      cities: ['Sao Paulo', 'Santiago', 'Berlin'],
    })
  }
  return items
}
