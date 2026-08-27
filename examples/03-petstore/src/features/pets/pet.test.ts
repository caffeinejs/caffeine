import { describe, it, expect } from "vitest";
import type { Pet as PetRow } from "@prisma/client";
import { toPetDTO } from "./pet.js";

// Pure unit test — no database. Exists so the example surfaces in the Vitest explorer and runs
// offline; DB-backed specs (if added) must be docker-gated per vitest.config.ts.
describe("toPetDTO", () => {
  const row = {
    id: "019b4132-70aa-764f-b315-e2803d882a24",
    species: "CAT",
    name: "Whiskers",
    breed: "Domestic Shorthair",
    ageMonths: 18,
    size: "MEDIUM",
    color: "Orange Tabby",
    gender: "MALE",
    goodWithKids: true,
    price: { toString: () => "75.00" },
    currency: "USD",
    description: "Friendly",
    status: "AVAILABLE",
    photos: ["https://cdn.example.com/1.jpg"],
    medicalInfo: { vaccinated: true },
    createdAt: new Date("2025-12-21T13:56:23.000Z"),
    updatedAt: new Date("2025-12-21T15:30:45.000Z"),
  } as unknown as PetRow;

  it("maps Decimal price to string and Dates to RFC 3339", () => {
    const dto = toPetDTO(row);
    expect(dto.price).toBe("75.00");
    expect(dto.createdAt).toBe("2025-12-21T13:56:23.000Z");
    expect(dto.updatedAt).toBe("2025-12-21T15:30:45.000Z");
  });

  it("surfaces optional/medical fields and keeps enums as-is", () => {
    const dto = toPetDTO(row);
    expect(dto.species).toBe("CAT");
    expect(dto.medicalInfo).toEqual({ vaccinated: true });
    expect(dto.photos).toEqual(["https://cdn.example.com/1.jpg"]);
  });

  it("normalizes nullable columns to undefined", () => {
    const dto = toPetDTO({
      ...row,
      breed: null,
      size: null,
      medicalInfo: null,
    } as unknown as PetRow);
    expect(dto.breed).toBeUndefined();
    expect(dto.size).toBeUndefined();
    expect(dto.medicalInfo).toBeUndefined();
  });
});
