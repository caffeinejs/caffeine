import type { User as UserRow } from '@prisma/client'

export interface UserDTO {
  id: string
  username: string
  firstName?: string
  lastName?: string
  email: string
  phone?: string
  createdAt: string
  updatedAt: string
}

export interface CreateUserDTO {
  username: string
  firstName?: string
  lastName?: string
  email: string
  phone?: string
  password: string
}

export type UpdateUserDTO = Partial<Omit<CreateUserDTO, 'username'>>

/** Maps a row to the API DTO, dropping the write-only `password`. */
export function toUserDTO(row: UserRow): UserDTO {
  return {
    id: row.id,
    username: row.username,
    firstName: row.firstName ?? undefined,
    lastName: row.lastName ?? undefined,
    email: row.email,
    phone: row.phone ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

const phonePattern = '^\\+?[1-9]\\d{1,14}$'

export const createUserSchema = {
  type: 'object',
  required: ['username', 'email', 'password'],
  properties: {
    username: { type: 'string', minLength: 3, maxLength: 50 },
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    email: { type: 'string', format: 'email' },
    phone: { type: 'string', pattern: phonePattern },
    password: { type: 'string', minLength: 8 },
  },
}

export const updateUserSchema = {
  type: 'object',
  properties: {
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    email: { type: 'string', format: 'email' },
    phone: { type: 'string', pattern: phonePattern },
    password: { type: 'string', minLength: 8 },
  },
}

export const userIdParamSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
}
