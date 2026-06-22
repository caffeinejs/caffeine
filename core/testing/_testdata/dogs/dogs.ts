export interface Dog {
  id: number
  name: string
  breed: string
  age: number
}

export interface CreateDogDTO {
  name: string
  breed: string
  age: number
}

export interface UpdateDogDTO {
  name?: string
  breed?: string
  age?: number
}
