import type { Order as OrderRow } from '@prisma/client'

export type OrderStatus = 'PLACED' | 'APPROVED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED'

export interface OrderDTO {
  id: string
  petId: string
  userId?: string
  status: OrderStatus
  totalAmount: string
  currency: string
  createdAt: string
  updatedAt: string
}

export interface CreateOrderDTO {
  petId: string
  userId?: string
  totalAmount?: string
  currency?: string
  status?: OrderStatus
}

export function toOrderDTO(row: OrderRow): OrderDTO {
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

export const createOrderSchema = {
  type: 'object',
  required: ['petId'],
  properties: {
    petId: { type: 'string', format: 'uuid' },
    userId: { type: 'string', format: 'uuid' },
    totalAmount: { type: 'string' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    status: { type: 'string', enum: ['PLACED', 'APPROVED', 'SHIPPED', 'DELIVERED', 'CANCELLED'] },
  },
}

export const orderIdParamSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
}
