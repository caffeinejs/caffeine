export interface BigItem {
  id: number
  message: string
  active: boolean
  cities: string[]
}

export function makeBigArray(size = 200): BigItem[] {
  const items: BigItem[] = new Array(size)
  for (let i = 0; i < size; i++) {
    items[i] = {
      id: i,
      message: 'Some Very Nice Message For Testing',
      active: true,
      cities: ['Sao Paulo', 'Santiago', 'Berlin'],
    }
  }
  return items
}
