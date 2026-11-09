import { $t, type InferSchema } from '@caffeinejs/application/schema'

/** `POST /ad`: one ad slot on one page, to be sold to the highest bidder. */
export const AdRequestSchema = $t.Object({
  slot: $t.Object({
    id: $t.String({ minLength: 1 }),
    w: $t.Integer({ minimum: 1 }),
    h: $t.Integer({ minimum: 1 }),
  }),
  /** The lowest price, in USD CPM, the publisher accepts. */
  floor: $t.Number({ minimum: 0 }),
  site: $t.Object({ domain: $t.String({ minLength: 1 }) }),
  user: $t.Optional($t.Object({ id: $t.String({ minLength: 1 }) })),
})

export type AdRequest = InferSchema<typeof AdRequestSchema>

/** The answer to `POST /ad` when a bid reached the floor. With none, the answer is 204 and no body. */
export interface AdResponse {
  readonly auctionID: string
  readonly winner: { readonly dsp: string; readonly price: number; readonly adm: string }
  /** How many DSPs bid at or above the floor. */
  readonly bids: number
}
