import rpcMap from "../data/rpc-map.json";

/** Identity of the checked-in RPC map; importing a verified update changes every decoder consumer. */
export const CURRENT_GAME_BUILD_FINGERPRINT = rpcMap.buildFingerprint;

export const BUNDLED_GAME_BUILD_FINGERPRINTS = [
  CURRENT_GAME_BUILD_FINGERPRINT,
] as const;

export type GameBuildFingerprint = (typeof BUNDLED_GAME_BUILD_FINGERPRINTS)[number];
