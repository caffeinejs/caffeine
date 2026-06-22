export interface Cat {
  id: number
  name: string
  breed: string
  age: number
}

export interface CreateCatDTO {
  name: string
  breed: string
  age: number
}

export interface UpdateCatDTO {
  name?: string
  breed?: string
  age?: number
}
