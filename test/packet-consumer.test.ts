import { expect, test } from "bun:test";
import type { CapturedFishNetPacket } from "@kar-mi/spirit-vale-tools-capture";
import { UPDATE_FULL } from "../src/core/character-data.ts";
import { consumeFishNetPacket } from "../src/core/packet-consumer.ts";
import { LootSession } from "../src/core/loot-session.ts";
import { Writer } from "../src/core/wire.ts";

// A complete character large enough for shape identification, with worn gear and a real bag.
function characterPayload(cardCount: number, equipmentPrefix = "bag-equipment", includesUpdateType = false): Buffer {
  const w = new Writer();
  if (includesUpdateType) w.packed(UPDATE_FULL);
  const equip = (uid: string) => w.objectRef(true)
    .list([], () => {}).list([], () => {}).packed(0).packed(0).packed(-1)
    .string(uid).packed(0).string("ArcaneChest").bool(false);
  w.objectRef(true).string("character").string("account").packed(1)
    .string("").string("").string("Replay Hero").objectRef(false).objectRef(false)
    .list([], () => {}).string(null).string(null).string(null)
    .list([6], value => w.packed(value)).packed(127).packed(0).packed(70).packed(0)
    .objectRef(false).list([60, 30, 10, 20, 5, 15], value => w.packed(value))
    .list([0], slot => { w.objectRef(true).packed(slot); equip("worn"); }).packed(0);
  for (let index = 0; index < 4; index++) w.list([], () => {});
  w.objectRef(false).list([], () => {}).objectRef(true)
    .dict(Array.from({ length: 60 }, (_, i) => [`${equipmentPrefix}-${i}`, `${equipmentPrefix}-${i}`] as const), equip)
    .dict([], () => {})
    .dict([["Abomination", cardCount]] as const, count => w.objectRef(true).packed(count).string("Abomination").bool(false));
  for (let index = 0; index < 4; index++) w.dict([], () => {});
  for (let index = 0; index < 5; index++) w.packed(0);
  return Buffer.from(w.bytes());
}

type PacketOptions = {
  rpcName?: string;
  direction?: string;
  equipmentPrefix?: string;
};

function packet(count: number, { rpcName, direction = "inbound", equipmentPrefix }: PacketOptions = {}): CapturedFishNetPacket {
  return {
    packetName: "rpcLink", rpcName, payload: characterPayload(count, equipmentPrefix, rpcName === "CharacterCallback_T"),
    liteNetPacket: { udpPacket: { direction } },
  } as CapturedFishNetPacket;
}

test("a stale RPC name cannot delay pickup alerts until the next unnamed map snapshot", () => {
  const sounds: string[] = [];
  const session = new LootSession({ soundsEnabled: () => true, onSound: sound => { sounds.push(sound); return true; } });
  session.setFilter('Show "cards"\n  Type Card\n  Sound alert');
  const consume = (input: CapturedFishNetPacket) => {
    const result = consumeFishNetPacket(input);
    if (result.snapshot) session.consume(result.snapshot, result.snapshotMode === "rebaseline");
  };
  consume(packet(1));
  expect(session.bag().find(item => item.kind === "card")?.count).toBe(1);
  expect(sounds).toEqual([]);

  // Observed live: current character callbacks carry the old vending callback's hash/name.
  consume(packet(2, { rpcName: "VendingCollectResult_T" }));
  expect(session.bag().find(item => item.kind === "card")?.count).toBe(2);
  expect(sounds).toEqual(["alert"]);
  expect(session.history().map(item => item.rule)).toEqual(["cards"]);

  consume(packet(2));
  expect(sounds).toEqual(["alert"]);
});

test("named map loads rebaseline raw equipment identities without muting the next pickup callback", () => {
  const pickups: Array<{ name: string; quantity: number }> = [];
  const session = new LootSession({ onPickup: pickup => { pickups.push(pickup); } });
  session.setFilter('Show "chests"\n  Type Chest\nShow "cards"\n  Type Card');
  const consume = (input: CapturedFishNetPacket) => {
    const result = consumeFishNetPacket(input);
    if (result.snapshot) session.consume(result.snapshot, result.snapshotMode === "rebaseline");
  };

  consume(packet(1, { rpcName: "LoadCharacter_T", equipmentPrefix: "current" }));
  consume(packet(2, { rpcName: "CharacterCallback_T", equipmentPrefix: "current" }));
  // EquipData.UID is the identity LootSession receives from the decoder. A map load may send a
  // fresh full inventory with those raw IDs while the owned card stack remains unchanged.
  consume(packet(2, { rpcName: "LoadCharacter_T", equipmentPrefix: "reloaded" }));
  consume(packet(3, { rpcName: "CharacterCallback_T", equipmentPrefix: "reloaded" }));

  expect(pickups.map(({ name, quantity }) => [name, quantity])).toEqual([
    ["Abomination Card", 1],
    ["Abomination Card", 1],
  ]);
});

test("shape recovery still rejects outbound and malformed named packets", () => {
  expect(consumeFishNetPacket(packet(2, { rpcName: "VendingCollectResult_T", direction: "outbound" }))).toEqual({ ignored: true });
  const malformed = packet(2, { rpcName: "VendingCollectResult_T" });
  malformed.payload = Buffer.alloc(4096, 255);
  expect(consumeFishNetPacket(malformed)).toEqual({ ignored: true });
});
