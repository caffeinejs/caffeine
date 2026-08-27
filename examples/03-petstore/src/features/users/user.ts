import { $t } from "@caffeinejs/std";
import type { User as UserRow } from "@prisma/client";

export interface UserDTO {
  id: string;
  username: string;
  firstName?: string;
  lastName?: string;
  email: string;
  phone?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateUserDTO {
  username: string;
  firstName?: string;
  lastName?: string;
  email: string;
  phone?: string;
  password: string;
}

export type UpdateUserDTO = Partial<Omit<CreateUserDTO, "username">>;

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
  };
}

const phone = $t.String({ pattern: "^\\+?[1-9]\\d{1,14}$" });

export const createUserSchema = $t.Object({
  username: $t.String({ minLength: 3, maxLength: 50 }),
  firstName: $t.Optional($t.String()),
  lastName: $t.Optional($t.String()),
  email: $t.String({ format: "email" }),
  phone: $t.Optional(phone),
  password: $t.String({ minLength: 8 }),
});

/** Everything but the username, which is immutable once the account exists. */
export const updateUserSchema = $t.Partial(
  $t.Omit(createUserSchema, ["username"]),
);

export const userIdParamSchema = $t.Object({
  id: $t.String(),
});

/**
 * Mirrors {@link UserDTO}. Built by omitting `password` from the create schema, the same field `toUserDTO`
 * drops — so the document cannot come to advertise a write-only field as part of the response.
 */
export const userSchema = $t.Object(
  {
    ...$t.Omit(createUserSchema, ["password"]).properties,
    id: $t.String(),
    createdAt: $t.String({ format: "date-time" }),
    updatedAt: $t.String({ format: "date-time" }),
  },
  { $id: "User" },
);
