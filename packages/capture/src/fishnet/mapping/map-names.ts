import { CURRENT_GAME_BUILD_FINGERPRINT } from "../../game-build.ts";
import { CURRENT_BUILD_MAP_NAMES } from "../generated/map-names.current.ts";

const MAPS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  // Map-name data is a separate snapshot: an RPC-only update must not claim it was regenerated.
  ce04a28c94ea82848b85c29d2867d2c9061a8972b998b30e898fcb3f65a166ba: CURRENT_BUILD_MAP_NAMES,
};

/** Returns the public display name for a current-build FishNet map ID. */
export function resolveBundledMapName(mapId: number, buildFingerprint: string = CURRENT_GAME_BUILD_FINGERPRINT): string | undefined {
  return MAPS[buildFingerprint]?.[mapId];
}
