import type { CapturedFishNetPacket } from "@kar-mi/spirit-vale-tools-capture";
import { decodeCharacterData, decodePersonalStorageBatch, decodeInventoryPayload, identifyCharacterPayload } from "./character-data.ts";
import type { SaviInventory, SaviSnapshot } from "./types.ts";

const characterRpcNames: Readonly<Record<string, true>> = { LoadCharacter_T: true, CharacterCallback_T: true };
const personalStorageRpcNames: Readonly<Record<string, true>> = {
  CompletePersonalStorageBatch: true,
  PlayerCallback_Storage: true,
};
export interface PacketConsumerResult {
  snapshot?: SaviSnapshot;
  /** LoadCharacter_T is a full map/character inventory rebaseline, not a pickup delta. */
  snapshotMode?: "delta" | "rebaseline";
  inventory?: SaviInventory;
  storage?: SaviInventory;
  ignored: boolean;
}
/** PacketCapture owns LiteNetLib fragmentation and FishNet split reassembly before this boundary. */
export function consumeFishNetPacket(packet: CapturedFishNetPacket): PacketConsumerResult {
  if (packet.liteNetPacket.udpPacket.direction === "outbound") return { ignored: true };
  if (packet.rpcName && characterRpcNames[packet.rpcName]) {
    try {
      return {
        snapshot: decodeCharacterData(packet.payload, { includesUpdateType: packet.rpcName === "CharacterCallback_T" }),
        snapshotMode: packet.rpcName === "LoadCharacter_T" ? "rebaseline" : "delta",
        ignored: false,
      };
    } catch {
      return { ignored: true };
    }
  }
  if (packet.rpcName && personalStorageRpcNames[packet.rpcName]) {
    const batch = decodePersonalStorageBatch(packet.payload);
    if (batch) return { ...batch, ignored: false };
    if (packet.rpcName === "PlayerCallback_Storage") {
      try {
        const storage = decodeInventoryPayload(packet.payload);
        if (storage) return { storage, ignored: false };
      } catch { /* Not a complete standalone storage inventory. */ }
    }
    return { ignored: true };
  }
  // RPC names come from a bundled build map and can be stale even on resolved links.
  // Validate character shape before discarding an otherwise unhandled named callback.
  const snapshot = identifyCharacterPayload(packet.payload);
  if (snapshot) return { snapshot, snapshotMode: "delta", ignored: false };
  if (packet.rpcName) return { ignored: true };
  const batch = decodePersonalStorageBatch(packet.payload);
  return batch ? { ...batch, ignored: false } : { ignored: true };
}
