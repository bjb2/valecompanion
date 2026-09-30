import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { parseFishNetRpcMap } from "../src/fishnet/mapping/validate-rpc-map.ts";

const FINGERPRINT = "a".repeat(64);

function validMap() {
  return {
    buildFingerprint: FINGERPRINT,
    metadataVersion: 1,
    behaviours: [{
      typeName: "KnownBehaviour",
      rpcs: [{ wireHash: 0, packetKind: "serverRpc", methodName: "KnownRpc" }],
    }],
    prefabs: [{
      collectionId: 0,
      prefabId: 0,
      components: [{ index: 0, typeName: "KnownBehaviour" }],
    }],
  };
}

describe("FishNet RPC map validation", () => {
  test("rejects an unsupported codec before it reaches the decoder", () => {
    const map = validMap();
    const candidate = {
      ...map,
      behaviours: [{
        ...map.behaviours[0],
        rpcs: [{ ...map.behaviours[0]!.rpcs[0], parameters: [{ name: "value", codec: "arbitraryReader" }] }],
      }],
    };

    expect(() => parseFishNetRpcMap(candidate)).toThrow("supported FishNet wire codec");
  });

  test("rejects duplicate RPC wire identities within a behaviour", () => {
    const map = validMap();
    const candidate = {
      ...map,
      behaviours: [{
        ...map.behaviours[0],
        rpcs: [...map.behaviours[0]!.rpcs, { wireHash: 0, packetKind: "serverRpc", methodName: "DifferentRpc" }],
      }],
    };

    expect(() => parseFishNetRpcMap(candidate)).toThrow("duplicates a wire identity");
  });

  test("rejects prefab components that cannot resolve to a declared behaviour", () => {
    const map = validMap();
    const candidate = {
      ...map,
      prefabs: [{
        ...map.prefabs[0],
        components: [{ index: 0, typeName: "MissingBehaviour" }],
      }],
    };

    expect(() => parseFishNetRpcMap(candidate)).toThrow("does not reference a declared behaviour");
  });

  test("does not replace the canonical map when an import candidate is malformed", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "valecompanion-rpc-map-"));
    const candidate = path.join(directory, "invalid.json");
    const canonical = new URL("../data/rpc-map.json", import.meta.url);
    const before = readFileSync(canonical, "utf8");
    writeFileSync(candidate, JSON.stringify({ ...validMap(), buildFingerprint: "not-a-fingerprint" }));

    try {
      const result = Bun.spawnSync([process.execPath, "../src/rpc-map.ts", "import", candidate], {
        cwd: path.dirname(fileURLToPath(import.meta.url)),
        stderr: "pipe",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("map.buildFingerprint");
      expect(readFileSync(canonical, "utf8")).toBe(before);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
