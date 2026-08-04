import { Injectable } from '@caffeinejs/di'
import { PrismaClient } from '@prisma/client'
import type { CreateUserDTO, UpdateUserDTO } from './user.js'
import { toUserDTO } from './user.js'

@Injectable([PrismaClient])
export class UsersRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(dto: CreateUserDTO) {
    // NOTE: passwords are stored in clear text here purely to keep the example small. A real
    // service must hash them (argon2/bcrypt) — never persist raw credentials.
    const row = await this.prisma.user.create({
      data: {
        username: dto.username,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        phone: dto.phone,
        password: dto.password,
      },
    })
    return toUserDTO(row)
  }

  async get(id: string) {
    const row = await this.prisma.user.findUnique({ where: { id } })
    return row ? toUserDTO(row) : undefined
  }

  async update(id: string, dto: UpdateUserDTO) {
    if ((await this.prisma.user.count({ where: { id } })) === 0) {
      return undefined
    }
    const row = await this.prisma.user.update({
      where: { id },
      data: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        phone: dto.phone,
        password: dto.password,
      },
    })
    return toUserDTO(row)
  }

  async remove(id: string): Promise<boolean> {
    if ((await this.prisma.user.count({ where: { id } })) === 0) {
      return false
    }
    await this.prisma.user.delete({ where: { id } })
    return true
  }

  /** Verifies credentials for the login endpoint; returns the user id when they match. */
  async verifyCredentials(username: string, password: string): Promise<string | undefined> {
    const row = await this.prisma.user.findUnique({ where: { username } })
    return row && row.password === password ? row.id : undefined
  }
}
