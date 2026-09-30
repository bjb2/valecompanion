import rpcMap from "../../../data/rpc-map.json";
import type { FishNetRpcMap } from "../types.ts";
import { parseFishNetRpcMap } from "./validate-rpc-map.ts";
import {
  BUNDLED_GAME_BUILD_FINGERPRINTS,
  CURRENT_GAME_BUILD_FINGERPRINT,
} from "../../game-build.ts";

const BUNDLED_RPC_MAP = parseFishNetRpcMap(rpcMap);

export type BundledFishNetBuildFingerprint = typeof CURRENT_GAME_BUILD_FINGERPRINT;

export function loadBundledFishNetRpcMap(
  buildFingerprint: string = CURRENT_GAME_BUILD_FINGERPRINT,
): FishNetRpcMap {
  if (buildFingerprint !== CURRENT_GAME_BUILD_FINGERPRINT) {
    throw new Error(
      `unsupported bundled FishNet build fingerprint ${JSON.stringify(buildFingerprint)}; supported: ` +
        BUNDLED_GAME_BUILD_FINGERPRINTS.join(", "),
    );
  }
  return BUNDLED_RPC_MAP;
}

