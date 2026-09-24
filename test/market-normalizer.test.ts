import { expect, test } from "bun:test";
import type { FishNetMarketListing } from "@kar-mi/spirit-vale-tools-market";
import { normalizeListing } from "../src/backend/market-normalizer.ts";

function listing(payload: object): FishNetMarketListing {
  return {
    listingId: "azure-antlers-listing",
    sellerAccountId: null,
    sellerDisplayName: null,
    itemDisplayName: "Azure Antlers",
    item: {
      itemId: "Azure Antlers",
      instanceId: "azure-antlers-instance",
      itemType: 3,
      quantity: 1,
      payloadJson: JSON.stringify(payload),
      payloadSchemaVersion: null,
      compatibilityFingerprint: null,
    },
    initialQuantity: 1,
    availableQuantity: 1,
    soldQuantity: 0,
    unitPrice: 200_000n,
    status: 1,
    version: 1n,
    createdAt: 0n,
    updatedAt: 0n,
    expiresAt: 0n,
  };
}

test("normalizes every Azure Antlers stat with its authoritative Headgear pool", async () => {
  const observation = await normalizeListing(listing({
    Id: "Azure Antlers",
    Substats: [
      { Type: 0, Value: 100, ValueStr: null },
      { Type: 72, Value: 100, ValueStr: null },
      { Type: 11, Value: 100, ValueStr: null },
    ],
  }));

  expect(observation?.stats).toEqual([
    { type: 0, name: "Str", value: 3, percent: false },
    { type: 72, name: "MpMult", value: 2, percent: true },
    { type: 11, name: "Def", value: 5, percent: false },
  ]);
});
