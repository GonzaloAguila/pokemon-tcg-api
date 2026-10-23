import { describe, expect, it } from "vitest";
import { ALL_VARIANTS, POOL_VARIANTS } from "../src/modules/prizes/catalog.js";
import { GRANTABLE_COSMETICS } from "../src/modules/admin/grantable-cosmetics.js";
import { resolveRandomOverlay } from "../src/modules/prizes/prizes.js";

describe("exclusive variants (Espectral)", () => {
  it("can be granted by hand, Fossil Gengar's included", () => {
    expect(ALL_VARIANTS.some((v) => v.itemId === "gengar-spectral" && v.name === "Gengar Espectral")).toBe(true);
    expect(GRANTABLE_COSMETICS.skin.has("gengar-spectral")).toBe(true);
  });

  it("are never a random prize", () => {
    expect(POOL_VARIANTS.some((v) => v.overlayId === "spectral")).toBe(false);
    for (let i = 0; i < 500; i++) {
      const prize = resolveRandomOverlay();
      expect(prize.type === "overlay" && prize.overlayId).not.toBe("spectral");
    }
  });
});
