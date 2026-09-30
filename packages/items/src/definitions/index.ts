import type { FishNetItemCatalog } from "../catalog.ts";
import { ArtifactItemDefinitions } from "./artifacts.ts";
import { CardItemDefinitions } from "./cards.ts";
import { ConsumableItemDefinitions } from "./consumables.ts";
import { CosmeticItemDefinitions } from "./cosmetics.ts";
import { EquipmentItemDefinitions } from "./equipment.ts";
import { GemItemDefinitions } from "./gems.ts";
import { JunkItemDefinitions } from "./junks.ts";

export const BUNDLED_ITEM_CATALOG_BUILD_FINGERPRINT = "ce04a28c94ea82848b85c29d2867d2c9061a8972b998b30e898fcb3f65a166ba";

export class ItemCatalogDefinitions {
  private constructor() {}

  static readonly catalog = {
    buildFingerprint: BUNDLED_ITEM_CATALOG_BUILD_FINGERPRINT,
    items: [
      ...JunkItemDefinitions.values,
      ...ConsumableItemDefinitions.values,
      ...EquipmentItemDefinitions.values,
      ...ArtifactItemDefinitions.values,
      ...CardItemDefinitions.values,
      ...GemItemDefinitions.values,
      ...CosmeticItemDefinitions.values,
    ],
  } as const satisfies FishNetItemCatalog;
}
