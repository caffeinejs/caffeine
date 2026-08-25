import { $t } from '@caffeinejs/std'
import type { Pet as PetRow } from '@prisma/client'

// --- API shapes (mirror spec/openapi.petstore.yaml #/components/schemas/Pet) ---

export type Species = 'DOG' | 'CAT' | 'RABBIT' | 'BIRD' | 'REPTILE' | 'OTHER'
export type Size = 'SMALL' | 'MEDIUM' | 'LARGE'
export type Gender = 'MALE' | 'FEMALE' | 'UNKNOWN'
export type PetStatus = 'AVAILABLE' | 'PENDING' | 'ADOPTED' | 'NOT_AVAILABLE'

export interface MedicalInfo {
  spayedNeutered?: boolean
  vaccinated?: boolean
  microchipped?: boolean
  specialNeeds?: boolean
  healthNotes?: string
}

export interface PetDTO {
  id: string
  species: Species
  name: string
  breed?: string
  ageMonths: number
  size?: Size
  color?: string
  gender?: Gender
  goodWithKids?: boolean
  price: string
  currency: string
  description?: string
  status: PetStatus
  photos: string[]
  medicalInfo?: MedicalInfo
  createdAt: string
  updatedAt: string
}

export interface CreatePetDTO {
  species: Species
  name: string
  breed?: string
  ageMonths: number
  size?: Size
  color?: string
  gender?: Gender
  goodWithKids?: boolean
  price: string
  currency?: string
  description?: string
  status?: PetStatus
  photos?: string[]
  medicalInfo?: MedicalInfo
}

export type UpdatePetDTO = Partial<CreatePetDTO>

export interface PetFilters {
  species?: Species
  status?: PetStatus
  size?: Size
  ageMin?: number
  ageMax?: number
  goodWithKids?: boolean
  page: number
  limit: number
}

export interface PetSearchCriteria {
  criteria?: {
    species?: Species[]
    ageRange?: { min?: number, max?: number }
    size?: Size[]
    compatibility?: { goodWithKids?: boolean }
  }
  sort?: { field?: 'ageMonths' | 'price', order?: 'ASC' | 'DESC' }
  pagination?: { page?: number, limit?: number }
}

export interface PetCollection {
  data: PetDTO[]
  pagination: { page: number, limit: number, totalItems: number, totalPages: number }
}

/** Maps a Prisma row to the API DTO: Decimal → string, Date → RFC 3339, Json → MedicalInfo. */
export function toPetDTO(row: PetRow): PetDTO {
  return {
    id: row.id,
    species: row.species,
    name: row.name,
    breed: row.breed ?? undefined,
    ageMonths: row.ageMonths,
    size: row.size ?? undefined,
    color: row.color ?? undefined,
    gender: row.gender ?? undefined,
    goodWithKids: row.goodWithKids ?? undefined,
    price: row.price.toString(),
    currency: row.currency,
    description: row.description ?? undefined,
    status: row.status,
    photos: row.photos,
    medicalInfo: (row.medicalInfo as MedicalInfo | null) ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

// --- Request schemas, in Caffeine's `$t` dialect ---
//
// A `$t` schema is a JSON Schema, so each of these is compiled straight into a Fastify Ajv validator when the route
// is registered. The same declaration also carries the TypeScript type, reachable with `InferSchema<typeof X>`.

// `satisfies` ties each list to the DTO union above, so adding a species to one without the other fails to compile.
const SPECIES = ['DOG', 'CAT', 'RABBIT', 'BIRD', 'REPTILE', 'OTHER'] as const satisfies readonly Species[]
const SIZE = ['SMALL', 'MEDIUM', 'LARGE'] as const satisfies readonly Size[]
const GENDER = ['MALE', 'FEMALE', 'UNKNOWN'] as const satisfies readonly Gender[]
const PET_STATUS = ['AVAILABLE', 'PENDING', 'ADOPTED', 'NOT_AVAILABLE'] as const satisfies readonly PetStatus[]

const species = $t.UnionEnum(SPECIES)
const size = $t.UnionEnum(SIZE)
const gender = $t.UnionEnum(GENDER)
const petStatus = $t.UnionEnum(PET_STATUS)

const medicalInfoSchema = $t.Object({
  spayedNeutered: $t.Optional($t.Boolean()),
  vaccinated: $t.Optional($t.Boolean()),
  microchipped: $t.Optional($t.Boolean()),
  specialNeeds: $t.Optional($t.Boolean()),
  healthNotes: $t.Optional($t.String()),
})

export const createPetSchema = $t.Object({
  species,
  name: $t.String({ minLength: 1, maxLength: 50 }),
  breed: $t.Optional($t.String()),
  ageMonths: $t.Integer({ minimum: 0 }),
  size: $t.Optional(size),
  color: $t.Optional($t.String()),
  gender: $t.Optional(gender),
  goodWithKids: $t.Optional($t.Boolean()),
  price: $t.String(),
  currency: $t.Optional($t.String({ pattern: '^[A-Z]{3}$' })),
  description: $t.Optional($t.String()),
  status: $t.Optional(petStatus),
  photos: $t.Optional($t.Array($t.String({ format: 'uri' }))),
  medicalInfo: $t.Optional(medicalInfoSchema),
})

/** Every field of the create schema, all optional — no second declaration to keep in step. */
export const updatePetSchema = $t.Partial(createPetSchema)

export const listPetsQuerySchema = $t.Object({
  species: $t.Optional(species),
  status: $t.Optional(petStatus),
  size: $t.Optional(size),
  ageMin: $t.Optional($t.Integer({ minimum: 0 })),
  ageMax: $t.Optional($t.Integer({ minimum: 0 })),
  goodWithKids: $t.Optional($t.Boolean()),
  page: $t.Integer({ minimum: 1, default: 1 }),
  limit: $t.Integer({ minimum: 1, maximum: 100, default: 20 }),
})

export const petIdParamSchema = $t.Object({
  id: $t.String({ format: 'uuid' }),
})

// --- Response schemas ---
//
// Composed from `createPetSchema` rather than restated, so a new field is declared once and reaches the
// request contract, the response contract and the OpenAPI document together. Declaring these also switches on
// Fastify's fast-json-stringify serialization for the routes that use them, so they earn their keep twice.
//
// The `$id` is what lands each one in components.schemas and turns every reference into a $ref.
export const petSchema = $t.Object({
  ...createPetSchema.properties,
  id: $t.String({ format: 'uuid' }),
  currency: $t.String({ pattern: '^[A-Z]{3}$' }),
  status: petStatus,
  photos: $t.Array($t.String({ format: 'uri' })),
  createdAt: $t.String({ format: 'date-time' }),
  updatedAt: $t.String({ format: 'date-time' }),
}, { $id: 'Pet' })

/** Mirrors {@link PetCollection} — the shape the repository actually returns. */
export const petListSchema = $t.Object({
  data: $t.Array(petSchema),
  pagination: $t.Object({
    page: $t.Integer(),
    limit: $t.Integer(),
    totalItems: $t.Integer(),
    totalPages: $t.Integer(),
  }),
}, { $id: 'PetList' })

export const petPhotoSchema = $t.Object({
  message: $t.String(),
  success: $t.Boolean(),
  photo: $t.String({ format: 'uri' }),
}, { $id: 'PetPhotoUploaded' })
