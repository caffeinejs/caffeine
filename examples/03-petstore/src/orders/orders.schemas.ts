import { $t, type InferSchema } from '@caffeinejs/std/schema'

/** Every schema this feature declares, and the types inferred from them. */

const ORDER_STATUS = ['PLACED', 'APPROVED', 'SHIPPED', 'DELIVERED', 'CANCELLED'] as const

export const OrderStatusSchema = $t.UnionEnum(ORDER_STATUS)

export const CreateOrderSchema = $t.Object({
  petId: $t.String({ format: 'uuid' }),
  userId: $t.Optional($t.String({ format: 'uuid' })),
  totalAmount: $t.Optional($t.String()),
  currency: $t.Optional($t.String({ pattern: '^[A-Z]{3}$' })),
  status: $t.Optional(OrderStatusSchema),
})

export const OrderIdParamSchema = $t.Object({
  id: $t.String({ format: 'uuid' }),
})

/** The `$id` puts it in components.schemas as `Order`. */
export const OrderSchema = $t.Object(
  {
    ...CreateOrderSchema.properties,
    id: $t.String({ format: 'uuid' }),
    status: OrderStatusSchema,
    totalAmount: $t.String(),
    currency: $t.String({ pattern: '^[A-Z]{3}$' }),
    createdAt: $t.String({ format: 'date-time' }),
    updatedAt: $t.String({ format: 'date-time' }),
  },
  { $id: 'Order' },
)

export type OrderStatus = InferSchema<typeof OrderStatusSchema>
export type OrderDTO = InferSchema<typeof OrderSchema>
export type CreateOrderDTO = InferSchema<typeof CreateOrderSchema>
