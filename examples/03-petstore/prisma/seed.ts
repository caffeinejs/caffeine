import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Idempotent-ish seed: only inserts when the pet table is empty, plus one demo user for login.
async function main() {
  const petCount = await prisma.pet.count();
  if (petCount === 0) {
    await prisma.pet.createMany({
      data: [
        {
          species: "CAT",
          name: "Whiskers",
          breed: "Domestic Shorthair",
          ageMonths: 18,
          size: "MEDIUM",
          color: "Orange Tabby",
          gender: "MALE",
          goodWithKids: true,
          price: new Prisma.Decimal("75.00"),
          currency: "USD",
          status: "AVAILABLE",
          description:
            "Friendly and playful orange tabby looking for a loving home",
          photos: ["https://cdn.petstoreapi.com/pets/whiskers/photo1.jpg"],
        },
        {
          species: "DOG",
          name: "Max",
          breed: "Labrador Retriever",
          ageMonths: 36,
          size: "LARGE",
          color: "Yellow",
          gender: "MALE",
          goodWithKids: true,
          price: new Prisma.Decimal("150.00"),
          currency: "USD",
          status: "AVAILABLE",
          description: "Energetic and loyal lab who loves fetch and long walks",
          photos: [],
        },
      ],
    });
  }

  await prisma.user.upsert({
    where: { username: "alice" },
    update: {},
    create: {
      username: "alice",
      firstName: "Alice",
      lastName: "Liddell",
      email: "alice@example.com",
      password: "wonderland",
    },
  });
}

main()
  .then(() => console.log("seed complete"))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
