import type {
  FishNetBehaviourDefinition,
  FishNetBroadcastDefinition,
  FishNetPrefabDefinition,
  FishNetRpcDefinition,
  FishNetRpcMap,
  FishNetRpcParameter,
  FishNetSyncTypeDefinition,
  FishNetWireCodec,
} from "../types.ts";

const WIRE_CODECS: Record<FishNetWireCodec, true> = {
  boolean: true,
  uint8: true,
  int8: true,
  uint16: true,
  int16: true,
  uint32: true,
  int32: true,
  float32: true,
  float64: true,
  packedInt32: true,
  packedInt64: true,
  packedInt32Array: true,
  packedUInt64: true,
  stringUtf8Packed: true,
  vector3IntPacked: true,
  vector2: true,
  vector3: true,
  quaternion: true,
  networkObject: true,
};

const RPC_PACKET_KINDS: Record<string, true> = {
  serverRpc: true,
  observersRpc: true,
  targetRpc: true,
  reconcile: true,
};


/** Parses the JSON-shaped FishNet map used by the decoder. It deliberately accepts no executable input. */
export function parseFishNetRpcMap(value: unknown): FishNetRpcMap {
  const root = record(value, "map");
  exactKeys(root, "map", ["buildFingerprint", "metadataVersion", "behaviours", "broadcasts", "prefabs"]);

  const buildFingerprint = sha256(root.buildFingerprint, "map.buildFingerprint");
  const metadataVersion = integer(root.metadataVersion, "map.metadataVersion", 1);
  const behavioursValue = array(root.behaviours, "map.behaviours");
  if (behavioursValue.length === 0) fail("map.behaviours must contain at least one behaviour");

  const behaviourNames = new Set<string>();
  const behaviours = behavioursValue.map((entry, index) => {
    const behaviour = parseBehaviour(entry, `map.behaviours[${index}]`);
    unique(behaviourNames, behaviour.typeName, `map.behaviours[${index}].typeName`);
    return behaviour;
  });

  const broadcasts = root.broadcasts === undefined
    ? undefined
    : parseBroadcasts(root.broadcasts, "map.broadcasts");
  const prefabs = root.prefabs === undefined
    ? undefined
    : parsePrefabs(root.prefabs, "map.prefabs", behaviourNames);

  return {
    buildFingerprint,
    metadataVersion,
    behaviours,
    ...(broadcasts === undefined ? {} : { broadcasts }),
    ...(prefabs === undefined ? {} : { prefabs }),
  };
}

function parseBehaviour(value: unknown, path: string): FishNetBehaviourDefinition {
  const input = record(value, path);
  exactKeys(input, path, ["typeName", "rpcs", "syncTypes"]);
  const typeName = text(input.typeName, `${path}.typeName`);
  const rpcsValue = input.rpcs === undefined ? [] : array(input.rpcs, `${path}.rpcs`);
  const rpcKeys = new Set<string>();
  const rpcs = rpcsValue.map((entry, index) => {
    const rpc = parseRpc(entry, `${path}.rpcs[${index}]`);
    unique(rpcKeys, `${rpc.packetKind}:${rpc.wireHash}`, `${path}.rpcs[${index}] wire key`);
    return rpc;
  });
  const syncTypes = input.syncTypes === undefined
    ? undefined
    : parseSyncTypes(input.syncTypes, `${path}.syncTypes`);
  if (rpcs.length === 0 && (syncTypes?.length ?? 0) === 0) {
    fail(`${path} has neither RPCs nor SyncTypes`);
  }
  return { typeName, rpcs, ...(syncTypes === undefined ? {} : { syncTypes }) };
}

function parseRpc(value: unknown, path: string): FishNetRpcDefinition {
  const input = record(value, path);
  exactKeys(input, path, ["wireHash", "packetKind", "methodName", "parameters"]);
  const wireHash = integer(input.wireHash, `${path}.wireHash`, 0, 0xffff);
  const packetKind = text(input.packetKind, `${path}.packetKind`);
  if (!Object.hasOwn(RPC_PACKET_KINDS, packetKind)) fail(`${path}.packetKind is not a supported RPC packet kind`);
  const methodName = text(input.methodName, `${path}.methodName`);
  const parameters = input.parameters === undefined
    ? undefined
    : parseParameters(input.parameters, `${path}.parameters`);
  return {
    wireHash,
    packetKind: packetKind as FishNetRpcDefinition["packetKind"],
    methodName,
    ...(parameters === undefined ? {} : { parameters }),
  };
}

function parseSyncTypes(value: unknown, path: string): FishNetSyncTypeDefinition[] {
  const values = array(value, path);
  const indices = new Set<number>();
  return values.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const input = record(entry, itemPath);
    exactKeys(input, itemPath, ["index", "name", "typeName", "codec", "fields"]);
    const syncIndex = integer(input.index, `${itemPath}.index`, 0, 0xff);
    unique(indices, syncIndex, `${itemPath}.index`);
    const name = text(input.name, `${itemPath}.name`);
    const typeName = optionalText(input.typeName, `${itemPath}.typeName`);
    const codec = optionalCodec(input.codec, `${itemPath}.codec`);
    const fields = input.fields === undefined ? undefined : parseParameters(input.fields, `${itemPath}.fields`);
    requireShape(codec, fields, itemPath);
    return {
      index: syncIndex,
      name,
      ...(typeName === undefined ? {} : { typeName }),
      ...(codec === undefined ? {} : { codec }),
      ...(fields === undefined ? {} : { fields }),
    };
  });
}

function parseParameters(value: unknown, path: string): FishNetRpcParameter[] {
  const values = array(value, path);
  const visited = new WeakSet<object>();
  visited.add(values);
  const result: FishNetRpcParameter[] = [];
  const lists: Array<{ source: unknown[]; path: string; target: FishNetRpcParameter[]; depth: number }> = [
    { source: values, path, target: result, depth: 0 },
  ];

  while (lists.length > 0) {
    const list = lists.pop()!;
    // Both the decoder and canonical serializer recurse through fields after validation.
    if (list.depth > 64) fail(`${list.path} exceeds the supported structured-field nesting depth`);
    const names = new Set<string>();
    for (let index = 0; index < list.source.length; index += 1) {
      const itemPath = `${list.path}[${index}]`;
      const input = record(list.source[index], itemPath);
      if (visited.has(input)) fail(`${itemPath} reuses a structured-field object`);
      visited.add(input);
      exactKeys(input, itemPath, ["name", "typeName", "nullable", "codec", "fields", "prefix", "repeated", "dictionaryKey"]);
      const name = text(input.name, `${itemPath}.name`);
      unique(names, name, `${itemPath}.name`);
      const typeName = optionalText(input.typeName, `${itemPath}.typeName`);
      const nullable = optionalBoolean(input.nullable, `${itemPath}.nullable`);
      const codec = optionalCodec(input.codec, `${itemPath}.codec`);
      const prefix = optionalBoolean(input.prefix, `${itemPath}.prefix`);
      const repeated = optionalBoolean(input.repeated, `${itemPath}.repeated`);
      const dictionaryKey = input.dictionaryKey === undefined
        ? undefined
        : parseDictionaryKey(input.dictionaryKey, `${itemPath}.dictionaryKey`);
      let fields: FishNetRpcParameter[] | undefined;
      if (input.fields !== undefined) {
        const sourceFields = array(input.fields, `${itemPath}.fields`);
        if (sourceFields.length === 0) fail(`${itemPath}.fields must not be empty`);
        if (visited.has(sourceFields)) fail(`${itemPath}.fields reuses a structured-field list`);
        visited.add(sourceFields);
        fields = [];
        lists.push({ source: sourceFields, path: `${itemPath}.fields`, target: fields, depth: list.depth + 1 });
      }
      requireShape(codec, fields, itemPath);
      list.target.push({
        name,
        ...(typeName === undefined ? {} : { typeName }),
        ...(nullable === undefined ? {} : { nullable }),
        ...(codec === undefined ? {} : { codec }),
        ...(fields === undefined ? {} : { fields }),
        ...(prefix === undefined ? {} : { prefix }),
        ...(repeated === undefined ? {} : { repeated }),
        ...(dictionaryKey === undefined ? {} : { dictionaryKey }),
      });
    }
  }
  return result;
}

function parseBroadcasts(value: unknown, path: string): FishNetBroadcastDefinition[] {
  const values = array(value, path);
  const hashes = new Set<number>();
  return values.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const input = record(entry, itemPath);
    exactKeys(input, itemPath, ["wireHash", "typeName", "fields"]);
    const wireHash = integer(input.wireHash, `${itemPath}.wireHash`, 0, 0xffff);
    unique(hashes, wireHash, `${itemPath}.wireHash`);
    const typeName = text(input.typeName, `${itemPath}.typeName`);
    const fields = input.fields === undefined ? undefined : parseParameters(input.fields, `${itemPath}.fields`);
    return { wireHash, typeName, ...(fields === undefined ? {} : { fields }) };
  });
}

function parsePrefabs(value: unknown, path: string, behaviourNames: ReadonlySet<string>): FishNetPrefabDefinition[] {
  const values = array(value, path);
  const prefabKeys = new Set<string>();
  return values.map((entry, index) => {
    const itemPath = `${path}[${index}]`;
    const input = record(entry, itemPath);
    exactKeys(input, itemPath, ["collectionId", "prefabId", "prefabName", "components"]);
    const collectionId = integer(input.collectionId, `${itemPath}.collectionId`, 0, 0xffff);
    const prefabId = integer(input.prefabId, `${itemPath}.prefabId`, 0);
    unique(prefabKeys, `${collectionId}:${prefabId}`, `${itemPath} prefab identity`);
    const prefabName = optionalText(input.prefabName, `${itemPath}.prefabName`);
    const componentsValue = array(input.components, `${itemPath}.components`);
    const componentIndices = new Set<number>();
    const components = componentsValue.map((component, componentIndex) => {
      const componentPath = `${itemPath}.components[${componentIndex}]`;
      const item = record(component, componentPath);
      exactKeys(item, componentPath, ["index", "typeName"]);
      const indexValue = integer(item.index, `${componentPath}.index`, 0, 0xff);
      unique(componentIndices, indexValue, `${componentPath}.index`);
      const typeName = text(item.typeName, `${componentPath}.typeName`);
      if (!behaviourNames.has(typeName)) {
        fail(`${componentPath}.typeName does not reference a declared behaviour`);
      }
      return { index: indexValue, typeName };
    });
    return {
      collectionId,
      prefabId,
      ...(prefabName === undefined ? {} : { prefabName }),
      components,
    };
  });
}

function requireShape(codec: FishNetWireCodec | undefined, fields: FishNetRpcParameter[] | undefined, path: string): void {
  if (codec !== undefined && fields !== undefined) fail(`${path} cannot have both codec and fields`);
}

function parseDictionaryKey(value: unknown, path: string): "stringUtf8Packed" {
  if (value !== "stringUtf8Packed") fail(`${path} must be stringUtf8Packed`);
  return value;
}

function optionalCodec(value: unknown, path: string): FishNetWireCodec | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !Object.hasOwn(WIRE_CODECS, value)) {
    fail(`${path} is not a supported FishNet wire codec`);
  }
  return value as FishNetWireCodec;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail(`${path} must be a boolean`);
  return value;
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : text(value, path);
}

function sha256(value: unknown, path: string): string {
  const fingerprint = text(value, path);
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) fail(`${path} must be a lowercase SHA-256 fingerprint`);
  return fingerprint;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${path} must be a non-empty string`);
  return value;
}

function integer(value: unknown, path: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${path} must be a safe integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${path} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${path} must be a plain object`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype" ||
      !allowed.includes(key)
    ) fail(`${path}.${key} is not a supported field`);
  }
}

function unique<T>(seen: Set<T>, value: T, path: string): void {
  if (seen.has(value)) fail(`${path} duplicates a wire identity`);
  seen.add(value);
}

function fail(message: string): never {
  throw new Error(`Invalid FishNet RPC map: ${message}`);
}
