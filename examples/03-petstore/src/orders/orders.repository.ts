import { Injectable } from '@caffeinejs/di'
import { ErrHTTPNotFound } from '@caffeinejs/http'
import { Prisma, PrismaClient, type Order as OrderRow } from '@prisma/client'

import type { CreateOrderDTO, OrderDTO } from './orders.schemas.js'

/** Maps a Prisma row to the API DTO: Decimal to string, Date to RFC 3339. */
function toOrderDTO(row: OrderRow): OrderDTO {
  return {
    id: row.id,
    petId: row.petId,
    userId: row.userId ?? undefined,
    status: row.status,
    totalAmount: row.totalAmount.toString(),
    currency: row.currency,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// A 404 ErrHTTP so the global error handler renders it without controller special-casing.
export class ErrPetNotFound extends ErrHTTPNotFound {
  constructor(petId: string) {
    super(`Cannot create order: pet "${petId}" does not exist`, {
      code: 'ERR_PET_NOT_FOUND',
    })
    this.name = 'ErrPetNotFound'
  }
}

@Injectable([PrismaClient])
export class OrdersRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(dto: CreateOrderDTO) {
    // Derive amount/currency from the pet when the caller omits them.
    const pet = await this.prisma.pet.findUnique({ where: { id: dto.petId } })
    if (!pet) {
      throw new ErrPetNotFound(dto.petId)
    }

    const row = await this.prisma.order.create({
      data: {
        petId: dto.petId,
        userId: dto.userId,
        status: dto.status ?? 'PLACED',
        totalAmount: dto.totalAmount !== undefined ? new Prisma.Decimal(dto.totalAmount) : pet.price,
        currency: dto.currency ?? pet.currency,
      },
    })
    return toOrderDTO(row)
  }

  async get(id: string) {
    const row = await this.prisma.order.findUnique({ where: { id } })
    return row ? toOrderDTO(row) : undefined
  }

  async remove(id: string): Promise<boolean> {
    if ((await this.prisma.order.count({ where: { id } })) === 0) {
      return false
    }
    await this.prisma.order.delete({ where: { id } })
    return true
  }
}
