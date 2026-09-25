import { $t, type InferSchema } from '@caffeinejs/std/schema'

/** Every schema this feature declares, and the types inferred from them. */

const PhoneSchema = $t.String({ pattern: '^\\+?[1-9]\\d{1,14}$' })

export const CreateUserSchema = $t.Object({
  username: $t.String({ minLength: 3, maxLength: 50 }),
  firstName: $t.Optional($t.String()),
  lastName: $t.Optional($t.String()),
  email: $t.String({ format: 'email' }),
  phone: $t.Optional(PhoneSchema),
  password: $t.String({ minLength: 8 }),
})

/** Everything but the username, which is immutable once the account exists. */
export const UpdateUserSchema = $t.Partial($t.Omit(CreateUserSchema, ['username']))

export const UserIdParamSchema = $t.Object({
  id: $t.String(),
})

/**
 * Built by omitting `password` from the create schema — the same field the row mapper drops, so the document
 * cannot come to advertise a write-only field as part of the response.
 */
export const UserSchema = $t.Object(
  {
    ...$t.Omit(CreateUserSchema, ['password']).properties,
    id: $t.String(),
    createdAt: $t.String({ format: 'date-time' }),
    updatedAt: $t.String({ format: 'date-time' }),
  },
  { $id: 'User' },
)

export type UserDTO = InferSchema<typeof UserSchema>
export type CreateUserDTO = InferSchema<typeof CreateUserSchema>
export type UpdateUserDTO = InferSchema<typeof UpdateUserSchema>
