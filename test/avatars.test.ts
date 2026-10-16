import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { FREE_AVATAR_IDS, updateCosmetics } from "../src/modules/users/users.service.js";
import { createUser } from "./helpers.js";

afterAll(async () => {
  await prisma.$disconnect();
});

describe("avatars", () => {
  it("anyone can wear a free Pokémon avatar", async () => {
    const user = await createUser();
    const result = await updateCosmetics(user.id, { activeAvatarId: "pkmn-pikachu" });
    expect(result.activeAvatarId).toBe("pkmn-pikachu");
    expect(FREE_AVATAR_IDS.has("collector")).toBe(true);
  });

  it("an avatar the player doesn't own is refused", async () => {
    const user = await createUser();
    await expect(updateCosmetics(user.id, { activeAvatarId: "snorlax" })).rejects.toThrow("No posees ese avatar");
    await expect(updateCosmetics(user.id, { activeAvatarId: "pkmn-missingno" })).rejects.toThrow("No posees ese avatar");
  });
});
