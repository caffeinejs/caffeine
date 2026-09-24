import { EntitySchema } from 'typeorm'

export interface User {
  id: number
  email: string
  orders?: Order[]
}

export interface Order {
  id: number
  total: number
  user?: User
}

export const UserEntity = new EntitySchema<User>({
  name: 'User',
  tableName: 'users',
  columns: {
    id: { type: Number, primary: true, generated: true },
    email: { type: String },
  },
  relations: {
    orders: { type: 'one-to-many', target: 'Order', inverseSide: 'user' },
  },
})

export const OrderEntity = new EntitySchema<Order>({
  name: 'Order',
  tableName: 'orders',
  columns: {
    id: { type: Number, primary: true, generated: true },
    total: { type: Number },
  },
  relations: {
    user: { type: 'many-to-one', target: 'User', inverseSide: 'orders', joinColumn: true },
  },
})
