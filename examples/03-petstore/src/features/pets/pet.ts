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

// --- JSON Schemas for @Schema (Fastify/Ajv dialect) ---

const SPECIES = ['DOG', 'CAT', 'RABBIT', 'BIRD', 'REPTILE', 'OTHER']
const SIZE = ['SMALL', 'MEDIUM', 'LARGE']
const GENDER = ['MALE', 'FEMALE', 'UNKNOWN']
const PET_STATUS = ['AVAILABLE', 'PENDING', 'ADOPTED', 'NOT_AVAILABLE']

const medicalInfoSchema = {
  type: 'object',
  properties: {
    spayedNeutered: { type: 'boolean' },
    vaccinated: { type: 'boolean' },
    microchipped: { type: 'boolean' },
    specialNeeds: { type: 'boolean' },
    healthNotes: { type: 'string' },
  },
}

export const createPetSchema = {
  type: 'object',
  required: ['species', 'name', 'ageMonths', 'price'],
  properties: {
    species: { type: 'string', enum: SPECIES },
    name: { type: 'string', minLength: 1, maxLength: 50 },
    breed: { type: 'string' },
    ageMonths: { type: 'integer', minimum: 0 },
    size: { type: 'string', enum: SIZE },
    color: { type: 'string' },
    gender: { type: 'string', enum: GENDER },
    goodWithKids: { type: 'boolean' },
    price: { type: 'string' },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    description: { type: 'string' },
    status: { type: 'string', enum: PET_STATUS },
    photos: { type: 'array', items: { type: 'string', format: 'uri' } },
    medicalInfo: medicalInfoSchema,
  },
}

export const updatePetSchema = {
  type: 'object',
  properties: createPetSchema.properties,
}

export const listPetsQuerySchema = {
  type: 'object',
  properties: {
    species: { type: 'string', enum: SPECIES },
    status: { type: 'string', enum: PET_STATUS },
    size: { type: 'string', enum: SIZE },
    ageMin: { type: 'integer', minimum: 0 },
    ageMax: { type: 'integer', minimum: 0 },
    goodWithKids: { type: 'boolean' },
    page: { type: 'integer', minimum: 1, default: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
}

export const petIdParamSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
}
