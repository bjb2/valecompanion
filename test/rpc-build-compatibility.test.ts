import { expect, test } from "bun:test";
import { FishNetSessionDecoder, loadBundledFishNetRpcMap } from "@valecompanion/capture";
import { decodeFishNetMarketPacket } from "@valecompanion/market";

function packed(value: number): Buffer {
  let remaining = BigInt(value) >= 0n ? BigInt(value) * 2n : -BigInt(value) * 2n - 1n;
  const bytes: number[] = [];
  do {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(byte | (remaining > 0n ? 128 : 0));
  } while (remaining > 0n);
  return Buffer.from(bytes);
}

function string(value: string | null): Buffer {
  if (value === null) return packed(-1);
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([packed(bytes.length), bytes]);
}

// 0.33.0 wire IDs from NetworkInitialize___Early, not looked up in the map under test.
function rpc(packetId: number, hash: number, payload: Buffer, componentIndex = 0): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt32LE(100);
  header.writeUInt16LE(packetId, 4);
  return Buffer.concat([header, packed(42), Buffer.from([1, componentIndex]), packed(payload.length + 1), Buffer.from([hash]), payload]);
}

test("0.33.0 market search traffic reaches the market decoder", () => {
  const decoder = new FishNetSessionDecoder(loadBundledFishNetRpcMap());
  const request = decoder.decode(rpc(8, 79, Buffer.concat([
    Buffer.from([0]), string("Candy Cane"), string(null), packed(25),
  ])), { reliable: true });
  expect(request.flatMap(decodeFishNetMarketPacket)).toEqual([
    { kind: "searchRequest", tick: 100, request: { query: "Candy Cane", cursor: null, pageSize: 25 } },
  ]);

  const response = decoder.decode(rpc(10, 80, string(JSON.stringify({
    Success: true, Code: 0, Message: null, Listings: [], NextCursor: "page-2", HasMore: true,
  }))), { reliable: true });
  expect(response.flatMap(decodeFishNetMarketPacket)).toEqual([
    { kind: "searchPage", tick: 100, page: {
      success: true, code: 0, message: null, listings: [], nextCursor: "page-2", hasMore: true,
    } },
  ]);
});

test("0.33.0 stacked consumable use decodes its count without leftover payload", () => {
  const decoder = new FishNetSessionDecoder(loadBundledFishNetRpcMap());
  // A balance callback establishes PlayerSave before the shared server-RPC hash is used.
  decoder.decode(rpc(10, 52, packed(1000), 7), { reliable: true });
  const [packet] = decoder.decode(rpc(8, 40, Buffer.concat([string("Potion"), packed(3)]), 7), { reliable: true });
  expect(packet?.rpcName).toBe("UseConsumable_S");
  expect(packet?.decodedFields?.map(({ name, value }) => ({ name, value }))).toEqual([
    { name: "consumableId", value: "Potion" },
    { name: "count", value: 3 },
  ]);
  expect(packet?.undecodedPayload).toBeUndefined();
});


test("0.33.0 damage keeps element and positions aligned after the autocast flag", () => {
  const decoder = new FishNetSessionDecoder(loadBundledFishNetRpcMap());
  const vectors = Buffer.alloc(24);
  [1, 2, 3, 4, 5, 6].forEach((value, index) => vectors.writeFloatLE(value, index * 4));
  const [packet] = decoder.decode(rpc(9, 0, Buffer.concat([
    packed(0), packed(150), packed(1), packed(0), packed(2), string("Fireball"),
    packed(42), Buffer.from([0, 0, 1]), packed(4), packed(3), packed(9), vectors,
  ])), { reliable: true });
  expect(packet?.rpcName).toBe("ApplyDamage_C");
  expect(Object.fromEntries(packet?.decodedFields?.map(({ name, value }) => [name, value]) ?? [])).toMatchObject({
    "dmg.IsAutocast": true,
    "dmg.Element": 4,
    "dmg.Range": 9,
    position: [1, 2, 3],
    origin: [4, 5, 6],
  });
  expect(packet?.undecodedPayload).toBeUndefined();
});