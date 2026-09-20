import { $t, type InferSchema } from '@caffeinejs/std'

/**
 * An open map rather than fixed keys: the response carries one entry per status that has pets, so the shape is
 * "string to count" and `additionalProperties` is what describes it honestly.
 */
export const InventorySchema = $t.Record($t.String(), $t.Integer(), { $id: 'Inventory' })

export type InventoryDTO = InferSchema<typeof InventorySchema>
