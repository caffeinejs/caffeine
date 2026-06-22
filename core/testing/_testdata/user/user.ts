export interface User {
  id: number
  name: string
  breed: string
  age: number
}

export interface CreateUserDTO {
  name: string
  breed: string
  age: number
}

export interface UpdateUserDTO {
  name?: string
  breed?: string
  age?: number
}
