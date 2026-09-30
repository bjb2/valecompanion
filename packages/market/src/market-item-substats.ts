import { resolveFishNetItem } from "@valecompanion/items";
import type { FishNetItemSubstatGroup } from "@valecompanion/items";

export type FishNetMarketSubstatGroup = FishNetItemSubstatGroup;

export function fishNetMarketSubstatGroup(
  baseItemId: string | undefined,
): FishNetMarketSubstatGroup | undefined {
  return resolveFishNetItem(2, baseItemId)?.substatGroup;
}
