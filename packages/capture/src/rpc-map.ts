#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FishNetPrefabDefinition, FishNetRpcMap } from "./fishnet/types.ts";
import { parseFishNetRpcMap } from "./fishnet/mapping/validate-rpc-map.ts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_MAP_PATH = path.join(PACKAGE_ROOT, "data", "rpc-map.json");
const USAGE = `Usage:
  bun packages/capture/src/rpc-map.ts export <output.json>
  bun packages/capture/src/rpc-map.ts check <input.json> [--prefab-layouts <prefab-layouts.json>]
  bun packages/capture/src/rpc-map.ts diff <input.json> [--prefab-layouts <prefab-layouts.json>]
  bun packages/capture/src/rpc-map.ts import <input.json> [--prefab-layouts <prefab-layouts.json>] [--same-build]
  bun packages/capture/src/rpc-map.ts fingerprint <GameAssembly.dll> <global-metadata.dat>

Inputs may be a canonical FishNet RPC map or an upstream rpc-build.json wrapper containing wireMap.
When supplied, --prefab-layouts joins rpcPrefabs' wire-safe component layouts to prefabs' names.
fingerprint streams SHA-256 over each file, then SHA-256s this exact UTF-8 manifest:
{"GameAssembly.dll":"<GameAssembly SHA-256>","global-metadata.dat":"<metadata SHA-256>"}.
That local provenance fingerprint does not establish wire compatibility or match legacy upstream fingerprints.
Changed definitions normally require a new build fingerprint. Use --same-build only to correct a map for the same verified game binaries.
This tool validates verified map edits and external datamine exports; it does not extract RPC metadata from binaries.`;

interface CommandInput {
  inputFile: string;
  prefabLayoutsFile?: string;
  sameBuild?: boolean;
}

interface MapSummary {
  behaviours: number;
  rpcs: number;
  syncTypes: number;
  broadcasts: number;
  prefabs: number;
}

async function main(args: readonly string[]): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(USAGE);
    return;
  }
  const [command, ...rest] = args;
  if (command === "fingerprint") {
    await printLocalFingerprint(rest);
    return;
  }
  if (command !== "export" && command !== "check" && command !== "diff" && command !== "import") {
    throw new Error(`Unknown command ${JSON.stringify(command)}.\n${USAGE}`);
  }
  const input = parseCommandInput(command, rest);

  if (command === "export") {
    const active = loadMap(CANONICAL_MAP_PATH);
    atomicWrite(input.inputFile, formatMap(active));
    printSummary("Exported", active);
    return;
  }

  const candidate = loadMap(input.inputFile, input.prefabLayoutsFile);
  if (command === "check") {
    printSummary("Valid", candidate);
    return;
  }

  const active = loadMap(CANONICAL_MAP_PATH);
  if (command === "diff") {
    printSummary("Active", active);
    printSummary("Candidate", candidate);
    printDiff(active, candidate);
    return;
  }

  const changed = stableJson(active) !== stableJson(candidate);
  if (changed && active.buildFingerprint === candidate.buildFingerprint && !input.sameBuild) {
    throw new Error(
      `Refusing to import a changed map with unchanged build fingerprint ${candidate.buildFingerprint}. ` +
      "Use the new build's fingerprint, or --same-build for a verified correction to the existing build.",
    );
  }
  if (!changed) {
    console.log("Map is identical to the active canonical map; nothing written.");
    return;
  }
  atomicWrite(CANONICAL_MAP_PATH, formatMap(candidate));
  printSummary("Imported", candidate);
}

function parseCommandInput(command: string, args: readonly string[]): CommandInput {
  if (args.length === 0 || args[0] === undefined) throw new Error(`Missing ${command} path.\n${USAGE}`);
  const inputFile = path.resolve(process.cwd(), args[0]);
  if (command === "export") {
    if (args.length !== 1) throw new Error(`export accepts exactly one output path.\n${USAGE}`);
    return { inputFile };
  }
  const input: CommandInput = { inputFile };
  for (let index = 1; index < args.length; index++) {
    if (args[index] === "--prefab-layouts" && input.prefabLayoutsFile === undefined && args[index + 1] !== undefined && !args[index + 1]!.startsWith("--")) {
      input.prefabLayoutsFile = path.resolve(process.cwd(), args[++index]!);
    } else if (command === "import" && args[index] === "--same-build" && !input.sameBuild) {
      input.sameBuild = true;
    } else {
      throw new Error(`Invalid ${command} arguments.\n${USAGE}`);
    }
  }
  return input;
}

async function printLocalFingerprint(args: readonly string[]): Promise<void> {
  if (args.length !== 2 || args[0] === undefined || args[1] === undefined) {
    throw new Error(`fingerprint requires GameAssembly.dll and global-metadata.dat paths.\n${USAGE}`);
  }
  const gameAssemblyPath = path.resolve(process.cwd(), args[0]);
  const metadataPath = path.resolve(process.cwd(), args[1]);
  const gameAssemblyHash = await sha256File(gameAssemblyPath, "GameAssembly.dll");
  const metadataHash = await sha256File(metadataPath, "global-metadata.dat");
  const manifest = JSON.stringify({
    "GameAssembly.dll": gameAssemblyHash,
    "global-metadata.dat": metadataHash,
  });
  const buildFingerprint = createHash("sha256").update(manifest, "utf8").digest("hex");
  console.log(`GameAssembly.dll SHA-256: ${gameAssemblyHash}`);
  console.log(`global-metadata.dat SHA-256: ${metadataHash}`);
  console.log(`manifest: ${manifest}`);
  console.log(`local buildFingerprint: ${buildFingerprint}`);
}

async function sha256File(filename: string, label: string): Promise<string> {
  if (!existsSync(filename)) throw new Error(`${label} not found: ${filename}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

function loadMap(filename: string, prefabLayoutsFile?: string): FishNetRpcMap {
  const value = readJson(filename);
  const mapValue = unwrapWireMap(value, filename);
  if (prefabLayoutsFile === undefined) return parseFishNetRpcMap(mapValue);

  const mapObject = plainRecord(mapValue, `${filename} wire map`);
  const withoutPrefabs = { ...mapObject };
  delete withoutPrefabs.prefabs;
  const wireMap = parseFishNetRpcMap(withoutPrefabs);
  const prefabs = joinPrefabLayouts(readJson(prefabLayoutsFile), prefabLayoutsFile);
  return parseFishNetRpcMap({ ...wireMap, prefabs });
}

function readJson(filename: string): unknown {
  if (!existsSync(filename)) throw new Error(`Map input not found: ${filename}`);
  try {
    return JSON.parse(readFileSync(filename, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse JSON from ${filename}: ${detail}`);
  }
}

function unwrapWireMap(value: unknown, filename: string): unknown {
  if (isPlainRecord(value) && Object.hasOwn(value, "wireMap")) return value.wireMap;
  if (value === null || typeof value !== "object") throw new Error(`${filename} must contain a FishNet map or rpc-build.json wrapper`);
  return value;
}

/** Mirrors the upstream generator: component layouts come from rpcPrefabs and names from prefabs. */
function joinPrefabLayouts(value: unknown, filename: string): FishNetPrefabDefinition[] {
  const root = plainRecord(value, `${filename} prefab layouts`);
  const namesByKey = new Map<string, string>();
  const prefabKeys = new Set<string>();
  for (const [index, entry] of optionalArray(root.prefabs, `${filename}.prefabs`).entries()) {
    const prefab = plainRecord(entry, `${filename}.prefabs[${index}]`);
    const collectionId = nonNegativeSafeInteger(prefab.collectionId, `${filename}.prefabs[${index}].collectionId`);
    const prefabId = nonNegativeSafeInteger(prefab.prefabId, `${filename}.prefabs[${index}].prefabId`);
    const key = `${collectionId}:${prefabId}`;
    if (prefabKeys.has(key)) throw new Error(`${filename}.prefabs[${index}] duplicates prefab ${key}`);
    prefabKeys.add(key);
    if (typeof prefab.prefabName === "string" && prefab.prefabName.length > 0) {
      namesByKey.set(`${collectionId}:${prefabId}`, prefab.prefabName);
    }
  }
  return requiredArray(root.rpcPrefabs, `${filename}.rpcPrefabs`).map((entry, prefabIndex) => {
    const pathPrefix = `${filename}.rpcPrefabs[${prefabIndex}]`;
    const prefab = plainRecord(entry, pathPrefix);
    const collectionId = nonNegativeSafeInteger(prefab.collectionId, `${pathPrefix}.collectionId`);
    const prefabId = nonNegativeSafeInteger(prefab.prefabId, `${pathPrefix}.prefabId`);
    const components = requiredArray(prefab.components, `${pathPrefix}.components`).map((component, componentIndex) => {
      const path = `${pathPrefix}.components[${componentIndex}]`;
      const source = plainRecord(component, path);
      return {
        index: nonNegativeSafeInteger(source.index, `${path}.index`),
        typeName: nonEmptyString(source.typeName, `${path}.typeName`),
      };
    });
    const prefabName = namesByKey.get(`${collectionId}:${prefabId}`);
    return {
      collectionId,
      prefabId,
      ...(prefabName === undefined ? {} : { prefabName }),
      components,
    };
  });
}

function printSummary(label: string, map: FishNetRpcMap): void {
  const summary = summarize(map);
  console.log(
    `${label}: ${map.buildFingerprint} (metadata ${map.metadataVersion}); ` +
    `${summary.behaviours} behaviours, ${summary.rpcs} RPCs, ${summary.syncTypes} SyncTypes, ` +
    `${summary.broadcasts} broadcasts, ${summary.prefabs} prefabs.`,
  );
}

function summarize(map: FishNetRpcMap): MapSummary {
  let rpcs = 0;
  let syncTypes = 0;
  for (const behaviour of map.behaviours) {
    rpcs += behaviour.rpcs.length;
    syncTypes += behaviour.syncTypes?.length ?? 0;
  }
  return {
    behaviours: map.behaviours.length,
    rpcs,
    syncTypes,
    broadcasts: map.broadcasts?.length ?? 0,
    prefabs: map.prefabs?.length ?? 0,
  };
}

function printDiff(active: FishNetRpcMap, candidate: FishNetRpcMap): void {
  const changes: string[] = [];
  if (active.buildFingerprint !== candidate.buildFingerprint) {
    changes.push(`build fingerprint: ${active.buildFingerprint} -> ${candidate.buildFingerprint}`);
  }
  if (active.metadataVersion !== candidate.metadataVersion) {
    changes.push(`metadata version: ${active.metadataVersion} -> ${candidate.metadataVersion}`);
  }
  diffIndexed(changes, "behaviour", active.behaviours, candidate.behaviours, (item) => item.typeName);
  diffIndexed(changes, "RPC", rpcEntries(active), rpcEntries(candidate), (item) => item.key, (item) => item.value);
  diffIndexed(changes, "SyncType", syncEntries(active), syncEntries(candidate), (item) => item.key, (item) => item.value);
  diffIndexed(changes, "broadcast", active.broadcasts ?? [], candidate.broadcasts ?? [], (item) => String(item.wireHash));
  diffIndexed(changes, "prefab", active.prefabs ?? [], candidate.prefabs ?? [], (item) => `${item.collectionId}:${item.prefabId}`);
  if (changes.length === 0) console.log("No map differences.");
  else for (const change of changes) console.log(change);
}

function diffIndexed<T>(
  output: string[],
  label: string,
  active: readonly T[],
  candidate: readonly T[],
  key: (value: T) => string,
  comparable: (value: T) => unknown = (value) => value,
): void {
  const oldValues = new Map(active.map((value) => [key(value), value]));
  const newValues = new Map(candidate.map((value) => [key(value), value]));
  for (const item of oldValues.keys()) {
    if (!newValues.has(item)) output.push(`- ${label} ${item}`);
  }
  for (const item of newValues.keys()) {
    if (!oldValues.has(item)) output.push(`+ ${label} ${item}`);
    else if (stableJson(comparable(oldValues.get(item)!)) !== stableJson(comparable(newValues.get(item)!))) {
      output.push(`~ ${label} ${item}`);
    }
  }
}

function rpcEntries(map: FishNetRpcMap): Array<{ key: string; value: unknown }> {
  return map.behaviours.flatMap((behaviour) => behaviour.rpcs.map((rpc) => ({
    key: `${behaviour.typeName}:${rpc.packetKind}:${rpc.wireHash}`,
    value: rpc,
  })));
}

function syncEntries(map: FishNetRpcMap): Array<{ key: string; value: unknown }> {
  return map.behaviours.flatMap((behaviour) => (behaviour.syncTypes ?? []).map((sync) => ({
    key: `${behaviour.typeName}:${sync.index}`,
    value: sync,
  })));
}

function atomicWrite(filename: string, contents: string): void {
  const temporary = `${filename}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, filename);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

function formatMap(map: FishNetRpcMap): string {
  return `${JSON.stringify(map, null, 2)}\n`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "undefined" : serialized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${path} must be a JSON object`);
  return value;
}

function optionalArray(value: unknown, path: string): unknown[] {
  if (value === undefined) return [];
  return requiredArray(value, path);
}

function requiredArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${path} must be a non-negative safe integer`);
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

if (import.meta.main) {
  void main(Bun.argv.slice(2)).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`rpc-map: ${detail}`);
    process.exitCode = 1;
  });
}
