import { $t, type InferSchema } from '@caffeinejs/std/schema'

/**
 * Every schema this feature declares, and the types inferred from them.
 *
 * A `$t` schema is a JSON Schema, so each of these compiles straight into a Fastify Ajv validator when the
 * route registers. The same declaration carries the TypeScript type, which is why nothing here is written
 * twice: `InferSchema<typeof PetSchema>` *is* the DTO, and a field added to the schema reaches the request
 * contract, the response contract, the OpenAPI document and the types together.
 */

const SPECIES = ['DOG', 'CAT', 'RABBIT', 'BIRD', 'REPTILE', 'OTHER'] as const
const SIZE = ['SMALL', 'MEDIUM', 'LARGE'] as const
const GENDER = ['MALE', 'FEMALE', 'UNKNOWN'] as const
const PET_STATUS = ['AVAILABLE', 'PENDING', 'ADOPTED', 'NOT_AVAILABLE'] as const

export const SpeciesSchema = $t.UnionEnum(SPECIES)
export const SizeSchema = $t.UnionEnum(SIZE)
export const GenderSchema = $t.UnionEnum(GENDER)
export const PetStatusSchema = $t.UnionEnum(PET_STATUS)

export const MedicalInfoSchema = $t.Object({
  spayedNeutered: $t.Optional($t.Boolean()),
  vaccinated: $t.Optional($t.Boolean()),
  microchipped: $t.Optional($t.Boolean()),
  specialNeeds: $t.Optional($t.Boolean()),
  healthNotes: $t.Optional($t.String()),
})

export const CreatePetSchema = $t.Object({
  species: SpeciesSchema,
  name: $t.String({ minLength: 1, maxLength: 50 }),
  breed: $t.Optional($t.String()),
  ageMonths: $t.Integer({ minimum: 0 }),
  size: $t.Optional(SizeSchema),
  color: $t.Optional($t.String()),
  gender: $t.Optional(GenderSchema),
  goodWithKids: $t.Optional($t.Boolean()),
  price: $t.String(),
  currency: $t.Optional($t.String({ pattern: '^[A-Z]{3}$' })),
  description: $t.Optional($t.String()),
  status: $t.Optional(PetStatusSchema),
  photos: $t.Optional($t.Array($t.String({ format: 'uri' }))),
  medicalInfo: $t.Optional(MedicalInfoSchema),
})

/** Every field of the create schema, all optional — no second declaration to keep in step. */
export const UpdatePetSchema = $t.Partial(CreatePetSchema)

export const ListPetsQuerySchema = $t.Object({
  species: $t.Optional(SpeciesSchema),
  status: $t.Optional(PetStatusSchema),
  size: $t.Optional(SizeSchema),
  ageMin: $t.Optional($t.Integer({ minimum: 0 })),
  ageMax: $t.Optional($t.Integer({ minimum: 0 })),
  goodWithKids: $t.Optional($t.Boolean()),
  page: $t.Integer({ minimum: 1, default: 1 }),
  limit: $t.Integer({ minimum: 1, maximum: 100, default: 20 }),
})

export const PetIdParamSchema = $t.Object({
  id: $t.String({ format: 'uuid' }),
})

/** The structured body of `QUERY /pets`, which is too nested to express as a query string. */
export const SearchPetsSchema = $t.Object({
  criteria: $t.Optional(
    $t.Object({
      species: $t.Optional($t.Array(SpeciesSchema)),
      ageRange: $t.Optional($t.Object({ min: $t.Optional($t.Integer()), max: $t.Optional($t.Integer()) })),
      size: $t.Optional($t.Array(SizeSchema)),
      compatibility: $t.Optional($t.Object({ goodWithKids: $t.Optional($t.Boolean()) })),
    }),
  ),
  sort: $t.Optional(
    $t.Object({
      field: $t.Optional($t.UnionEnum(['ageMonths', 'price'] as const)),
      order: $t.Optional($t.UnionEnum(['ASC', 'DESC'] as const)),
    }),
  ),
  pagination: $t.Optional($t.Object({ page: $t.Optional($t.Integer()), limit: $t.Optional($t.Integer()) })),
})

// --- Response schemas ---
//
// Composed from `CreatePetSchema` rather than restated. Declaring them also switches on Fastify's
// fast-json-stringify serialization for the routes that use them, so they earn their keep twice. The `$id` is
// what lands each one in components.schemas and turns every reference into a $ref.

export const PetSchema = $t.Object(
  {
    ...CreatePetSchema.properties,
    id: $t.String({ format: 'uuid' }),
    currency: $t.String({ pattern: '^[A-Z]{3}$' }),
    status: PetStatusSchema,
    photos: $t.Array($t.String({ format: 'uri' })),
    createdAt: $t.String({ format: 'date-time' }),
    updatedAt: $t.String({ format: 'date-time' }),
  },
  { $id: 'Pet' },
)

export const PetListSchema = $t.Object(
  {
    data: $t.Array(PetSchema),
    pagination: $t.Object({
      page: $t.Integer(),
      limit: $t.Integer(),
      totalItems: $t.Integer(),
      totalPages: $t.Integer(),
    }),
  },
  { $id: 'PetList' },
)

export const PetPhotoSchema = $t.Object(
  {
    message: $t.String(),
    success: $t.Boolean(),
    photo: $t.String({ format: 'uri' }),
  },
  { $id: 'PetPhotoUploaded' },
)

export type Species = InferSchema<typeof SpeciesSchema>
export type Size = InferSchema<typeof SizeSchema>
export type Gender = InferSchema<typeof GenderSchema>
export type PetStatus = InferSchema<typeof PetStatusSchema>
export type MedicalInfo = InferSchema<typeof MedicalInfoSchema>
export type PetDTO = InferSchema<typeof PetSchema>
export type CreatePetDTO = InferSchema<typeof CreatePetSchema>
export type UpdatePetDTO = InferSchema<typeof UpdatePetSchema>
export type PetCollection = InferSchema<typeof PetListSchema>
export type PetSearchCriteria = InferSchema<typeof SearchPetsSchema>

/** The filters the repository lists on: the query schema, with pagination already defaulted. */
export type PetFilters = InferSchema<typeof ListPetsQuerySchema>
