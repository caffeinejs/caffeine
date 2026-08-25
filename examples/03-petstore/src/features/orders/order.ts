import { $t } from '@caffeinejs/std'
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

const ORDER_STATUS = ['PLACED', 'APPROVED', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const satisfies readonly OrderStatus[]

export const createOrderSchema = $t.Object({
  petId: $t.String({ format: 'uuid' }),
  userId: $t.Optional($t.String({ format: 'uuid' })),
  totalAmount: $t.Optional($t.String()),
  currency: $t.Optional($t.String({ pattern: '^[A-Z]{3}$' })),
  status: $t.Optional($t.UnionEnum(ORDER_STATUS)),
})

export const orderIdParamSchema = $t.Object({
  id: $t.String({ format: 'uuid' }),
})

/** Mirrors {@link OrderDTO}. The `$id` puts it in components.schemas as `Order`. */
export const orderSchema = $t.Object({
  ...createOrderSchema.properties,
  id: $t.String({ format: 'uuid' }),
  status: $t.UnionEnum(ORDER_STATUS),
  totalAmount: $t.String(),
  currency: $t.String({ pattern: '^[A-Z]{3}$' }),
  createdAt: $t.String({ format: 'date-time' }),
  updatedAt: $t.String({ format: 'date-time' }),
}, { $id: 'Order' })
