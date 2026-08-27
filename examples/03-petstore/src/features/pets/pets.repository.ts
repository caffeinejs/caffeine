import { Injectable } from "@caffeinejs/di";
import { Prisma, PrismaClient } from "@prisma/client";
import type {
  CreatePetDTO,
  PetCollection,
  PetFilters,
  PetSearchCriteria,
  UpdatePetDTO,
} from "./pet.js";
import { toPetDTO } from "./pet.js";

// Data access for pets. Owns all Prisma queries and the row → API DTO mapping; the controller
// stays free of persistence concerns (controller → repository, no service layer).
@Injectable([PrismaClient])
export class PetsRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async list(filters: PetFilters): Promise<PetCollection> {
    const where: Prisma.PetWhereInput = {};
    if (filters.species) {
      where.species = filters.species;
    }
    if (filters.status) {
      where.status = filters.status;
    }
    if (filters.size) {
      where.size = filters.size;
    }
    if (filters.goodWithKids !== undefined) {
      where.goodWithKids = filters.goodWithKids;
    }
    if (filters.ageMin !== undefined || filters.ageMax !== undefined) {
      where.ageMonths = {};
      if (filters.ageMin !== undefined) {
        where.ageMonths.gte = filters.ageMin;
      }
      if (filters.ageMax !== undefined) {
        where.ageMonths.lte = filters.ageMax;
      }
    }

    const [rows, totalItems] = await Promise.all([
      this.prisma.pet.findMany({
        where,
        skip: (filters.page - 1) * filters.limit,
        take: filters.limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.pet.count({ where }),
    ]);

    return {
      data: rows.map(toPetDTO),
      pagination: {
        page: filters.page,
        limit: filters.limit,
        totalItems,
        totalPages: Math.ceil(totalItems / filters.limit),
      },
    };
  }

  async search(body: PetSearchCriteria): Promise<PetCollection> {
    const c = body.criteria ?? {};
    const where: Prisma.PetWhereInput = {};
    if (c.species?.length) {
      where.species = { in: c.species };
    }
    if (c.size?.length) {
      where.size = { in: c.size };
    }
    if (c.compatibility?.goodWithKids !== undefined) {
      where.goodWithKids = c.compatibility.goodWithKids;
    }
    if (
      c.ageRange &&
      (c.ageRange.min !== undefined || c.ageRange.max !== undefined)
    ) {
      where.ageMonths = {};
      if (c.ageRange.min !== undefined) {
        where.ageMonths.gte = c.ageRange.min;
      }
      if (c.ageRange.max !== undefined) {
        where.ageMonths.lte = c.ageRange.max;
      }
    }

    const page = body.pagination?.page ?? 1;
    const limit = body.pagination?.limit ?? 20;
    const orderBy: Prisma.PetOrderByWithRelationInput = body.sort?.field
      ? { [body.sort.field]: body.sort.order === "DESC" ? "desc" : "asc" }
      : { createdAt: "desc" };

    const [rows, totalItems] = await Promise.all([
      this.prisma.pet.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy,
      }),
      this.prisma.pet.count({ where }),
    ]);

    return {
      data: rows.map(toPetDTO),
      pagination: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
      },
    };
  }

  async get(id: string) {
    const row = await this.prisma.pet.findUnique({ where: { id } });
    return row ? toPetDTO(row) : undefined;
  }

  async create(dto: CreatePetDTO) {
    const row = await this.prisma.pet.create({
      data: {
        species: dto.species,
        name: dto.name,
        breed: dto.breed,
        ageMonths: dto.ageMonths,
        size: dto.size,
        color: dto.color,
        gender: dto.gender,
        goodWithKids: dto.goodWithKids,
        price: new Prisma.Decimal(dto.price),
        currency: dto.currency ?? "USD",
        description: dto.description,
        status: dto.status ?? "AVAILABLE",
        photos: dto.photos ?? [],
        medicalInfo: dto.medicalInfo
          ? (dto.medicalInfo as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });
    return toPetDTO(row);
  }

  async update(id: string, dto: UpdatePetDTO) {
    if (!(await this.exists(id))) {
      return undefined;
    }
    const row = await this.prisma.pet.update({
      where: { id },
      data: {
        species: dto.species,
        name: dto.name,
        breed: dto.breed,
        ageMonths: dto.ageMonths,
        size: dto.size,
        color: dto.color,
        gender: dto.gender,
        goodWithKids: dto.goodWithKids,
        price:
          dto.price !== undefined ? new Prisma.Decimal(dto.price) : undefined,
        currency: dto.currency,
        description: dto.description,
        status: dto.status,
        photos: dto.photos,
        medicalInfo: dto.medicalInfo as Prisma.InputJsonValue | undefined,
      },
    });
    return toPetDTO(row);
  }

  async addPhoto(id: string, url: string) {
    if (!(await this.exists(id))) {
      return undefined;
    }
    const row = await this.prisma.pet.update({
      where: { id },
      data: { photos: { push: url } },
    });
    return toPetDTO(row);
  }

  async remove(id: string): Promise<boolean> {
    if (!(await this.exists(id))) {
      return false;
    }
    await this.prisma.pet.delete({ where: { id } });
    return true;
  }

  async countByStatus(): Promise<Record<string, number>> {
    const groups = await this.prisma.pet.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const g of groups) {
      out[g.status] = g._count._all;
    }
    return out;
  }

  private async exists(id: string): Promise<boolean> {
    return (await this.prisma.pet.count({ where: { id } })) > 0;
  }
}
