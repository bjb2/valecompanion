import { describe, expect, test } from "bun:test";
import type { CapturedFishNetPacket } from "@valecompanion/capture";
import { GoldSession } from "../src/core/gold-session.ts";
import type { SaviSnapshot } from "../src/core/types.ts";

const START = Date.parse("2026-09-04T12:00:00.000Z");
const MIN = 60_000;

describe("GoldSession", () => {
  test("computes gross, spend, net, and normalized session rates from balance deltas", () => {
    const session = new GoldSession();
    session.consumeBalance(1_000, START);
    session.consumeBalance(1_250, START + 30 * 60_000);
    session.consumeBalance(1_200, START + 60 * 60_000);

    const view = session.snapshot(START + 60 * 60_000);
    expect(view.status).toBe("tracking");
    expect(view.balance).toBe(1_200);
    expect(view.earned).toBe(250);
    expect(view.spent).toBe(50);
    expect(view.net).toBe(200);
    expect(view.goldPerHour).toBe(250);
    expect(view.goldPerMinute).toBeCloseTo(250 / 60);
    expect(view.netPerHour).toBe(200);
    expect(view.earningEvents).toBe(1);
    expect(view.spendingEvents).toBe(1);
    expect(view.averageGoldPerEvent).toBe(250);
  });

  test("excludes a large starting balance from rates before and after restore", () => {
    const session = new GoldSession();
    session.consumePacket(coinPacket("CoinsCallback_T", 8_000_000, 20, START));
    const restored = GoldSession.restore(JSON.parse(JSON.stringify(session.persisted())));

    restored.consumePacket(coinPacket("CoinsCallback_T", 8_000_000, 21, START + 60_000));
    expect(restored.snapshot(START + 60_000).goldPerHour).toBe(0);

    restored.consumePacket(coinPacket("ExpCoinsChanged_T", 8_001_000, 21, START + 120_000));
    const view = restored.snapshot(START + 120_000);
    expect(view.earned).toBe(1_000);
    // The process restarted between the two packets; the clock only runs from the first packet
    // seen after the restore, so the 1_000 was earned over one active minute, not two.
    expect(view.goldPerHour).toBe(60_000);
  });

  test("keeps one session across transient player object IDs and process restarts", () => {
    const session = new GoldSession();
    expect(session.consumePacket(coinPacket("CoinsCallback_T", "5000", 10, START))).toBe(true);
    expect(session.consumePacket(coinPacket("ExpCoinsChanged_T", "5600", 10, START + 60_000))).toBe(true);
    expect(session.snapshot(START + 60_000).earned).toBe(600);
    session.consumeSnapshot({ monsterKills: 42 } as SaviSnapshot);

    const resumed = GoldSession.restore(JSON.parse(JSON.stringify(session.persisted())));
    resumed.consumePacket(coinPacket("CoinsCallback_T", 5_700, 11, START + 120_000));
    const switched = resumed.snapshot(START + 120_000);
    expect(switched.balance).toBe(5_700);
    expect(switched.earned).toBe(700);
    expect(switched.net).toBe(700);
    expect(switched.killCountAvailable).toBe(true);
    expect(switched.previousSessions).toEqual([]);
  });

  test("derives per-kill efficiency only from observed cumulative monster counts", () => {
    const session = new GoldSession();
    session.consumeBalance(2_000, START);
    session.consumeSnapshot({ monsterKills: 100 } as SaviSnapshot);
    session.consumeSnapshot({ monsterKills: 103 } as SaviSnapshot);
    session.consumeBalance(2_300, START + 60_000);
    session.consumeSnapshot({ monsterKills: 105 } as SaviSnapshot);

    const view = session.snapshot(START + 60_000);
    expect(view.killCountAvailable).toBe(true);
    expect(view.monsterKills).toBe(5);
    expect(view.unconfirmedMonsterKills).toBe(2);
    expect(view.goldPerMonsterKill).toBe(100);
  });

  test("finishing a session archives its results and keeps the current balance as the new baseline", () => {
    const session = new GoldSession();
    session.consumeBalance(1_000, START);
    session.consumeSnapshot({ monsterKills: 10 } as SaviSnapshot);
    session.consumeSnapshot({ monsterKills: 12 } as SaviSnapshot);
    session.consumeBalance(1_500, START + 60_000);
    session.reset(START + 60_000);
    session.consumeBalance(1_650, START + 120_000);

    const view = session.snapshot(START + 120_000);
    expect(view.startedAt).toBe("2026-09-04T12:01:00.000Z");
    expect(view.earned).toBe(150);
    expect(view.goldPerHour).toBe(9_000);
    expect(view.previousSessions).toHaveLength(1);
    expect(view.previousSessions[0]).toMatchObject({
      elapsedSeconds: 60,
      startingBalance: 1_000,
      endingBalance: 1_500,
      earned: 500,
      spent: 0,
      net: 500,
      goldPerHour: 30_000,
      monsterKills: 2,
      goldPerMonsterKill: 250,
    });
  });

  test("restores active analytics and saved sessions across process restarts", () => {
    const session = new GoldSession();
    session.consumeBalance(1_000, START);
    session.consumeBalance(1_500, START + 60_000);
    session.reset(START + 60_000);
    session.consumeBalance(1_650, START + 120_000);

    const restored = GoldSession.restore(JSON.parse(JSON.stringify(session.persisted())));
    const active = restored.snapshot(START + 180_000);
    // Restored sessions start paused: the minute the process was down is not played time.
    expect(active).toMatchObject({
      status: "paused",
      balance: 1_650,
      earned: 150,
      previousSessions: [{ startingBalance: 1_000, endingBalance: 1_500, net: 500 }],
    });
    expect(active.elapsedSeconds).toBe(60);
    expect(active.goldPerHour).toBe(9_000);

    restored.end(START + 180_000);
    const ended = restored.snapshot(START + 180_000);
    expect(ended.status).toBe("waiting");
    expect(ended.previousSessions).toHaveLength(2);
    expect(ended.previousSessions[0]).toMatchObject({
      startingBalance: 1_500,
      endingBalance: 1_650,
      earned: 150,
      elapsedSeconds: 60,
    });

    restored.clearHistory();
    expect(restored.snapshot(START + 180_000).previousSessions).toEqual([]);
  });

  test("deletes only the selected finished session and persists the removal", () => {
    const session = new GoldSession();
    session.consumeBalance(1_000, START);
    session.consumeBalance(1_100, START + 60_000);
    session.reset(START + 60_000);
    session.consumeBalance(1_300, START + 120_000);
    session.reset(START + 120_000);

    const before = session.snapshot(START + 180_000);
    expect(before.previousSessions).toHaveLength(2);
    const deletedId = before.previousSessions[1]!.id;
    const retainedId = before.previousSessions[0]!.id;

    expect(session.deleteSession(deletedId)).toBe(true);
    expect(session.deleteSession(deletedId)).toBe(false);
    const after = session.snapshot(START + 180_000);
    expect(after.status).toBe("tracking");
    expect(after.balance).toBe(1_300);
    expect(after.previousSessions.map((entry) => entry.id)).toEqual([retainedId]);

    const restored = GoldSession.restore(JSON.parse(JSON.stringify(session.persisted())));
    expect(restored.snapshot(START + 180_000).previousSessions.map((entry) => entry.id)).toEqual([retainedId]);
  });

  test("ignores outbound and malformed currency packets", () => {
    const session = new GoldSession();
    const outbound = coinPacket("CoinsCallback_T", 100, 1, START);
    outbound.liteNetPacket.udpPacket.direction = "outbound";
    expect(session.consumePacket(outbound)).toBe(false);
    expect(session.consumePacket({ ...coinPacket("CoinsCallback_T", 100, 1, START), decodedFields: [] })).toBe(false);
    expect(session.snapshot(START).status).toBe("waiting");
  });
});

function coinPacket(rpcName: string, coins: number | string, objectId: number, observedAt: number): CapturedFishNetPacket {
  const payload = Buffer.alloc(0);
  return {
    tick: 0,
    packetId: 0,
    packetName: "targetRpc",
    raw: payload,
    payload,
    rpcName,
    objectId,
    connectionId: "test",
    decodedFields: [{ name: "coins", codec: "packedInt64", value: coins }],
    liteNetPacket: {
      mergePath: [],
      packet: {
        propertyId: 1,
        property: "channeled",
        connectionNumber: 0,
        fragmented: false,
        sequence: 1,
        channel: 0,
        raw: payload,
        payload,
      },
      udpPacket: {
        protocol: "udp",
        timestampTicks: 0n,
        capturedAt: new Date(observedAt),
        interfaceIndex: 0,
        subinterfaceIndex: 0,
        direction: "inbound",
        loopback: false,
        ipVersion: 4,
        sourceIP: "203.0.113.10",
        destinationIP: "192.0.2.5",
        sourcePort: 7000,
        destinationPort: 6000,
        truncated: false,
        payload,
      },
    },
  };
}

describe("GoldSession pauses while the game is off", () => {
  test("time with the game closed does not count toward rates or session length", () => {
    const session = new GoldSession();
    session.consumeBalance(1_000, START);
    session.consumeBalance(1_600, START + 30 * MIN);
    session.setGameActive(false, START + 30 * MIN);
    const afterLongBreak = session.snapshot(START + 5 * 60 * MIN);
    expect(afterLongBreak.status).toBe("paused");
    expect(afterLongBreak.elapsedSeconds).toBe(30 * 60);
    expect(afterLongBreak.goldPerHour).toBe(1_200);
    expect(afterLongBreak.recentGoldPerHour).toBe(0);
  });

  test("the clock resumes when the game returns and only the played stretches add up", () => {
    const session = new GoldSession();
    session.consumeBalance(1_000, START);
    session.setGameActive(false, START + 10 * MIN);
    session.setGameActive(true, START + 70 * MIN);
    session.consumeBalance(1_500, START + 80 * MIN);
    const view = session.snapshot(START + 80 * MIN);
    expect(view.status).toBe("tracking");
    expect(view.elapsedSeconds).toBe(20 * 60);
    expect(view.goldPerHour).toBe(1_500);
    expect(view.recentGoldPerHour).toBe(3_000);                // 500 in the 10 active minutes of the last 15
  });

  test("a balance update while marked paused resumes the clock on its own", () => {
    const session = new GoldSession();
    session.consumeBalance(1_000, START);
    session.setGameActive(false, START + 5 * MIN);
    session.consumeBalance(1_100, START + 65 * MIN);
    expect(session.snapshot(START + 65 * MIN).status).toBe("tracking");
    expect(session.snapshot(START + 70 * MIN).elapsedSeconds).toBe(10 * 60); // 5 played + 5 since the update
  });

  test("restoring from disk starts paused and keeps the played time, old saves included", () => {
    const session = new GoldSession();
    session.consumeBalance(1_000, START);
    session.consumeBalance(1_300, START + 15 * MIN);
    const restored = GoldSession.restore(session.persisted());
    const view = restored.snapshot(START + 8 * 60 * MIN);
    expect(view.status).toBe("paused");
    expect(view.elapsedSeconds).toBe(15 * 60);
    expect(view.goldPerHour).toBe(1_200);

    const { activeMs, activeSince, ...legacyActive } = session.persisted().active!;
    const fromLegacy = GoldSession.restore({ ...session.persisted(), active: legacyActive });
    expect(fromLegacy.snapshot(START + 8 * 60 * MIN).elapsedSeconds).toBe(15 * 60);
  });

  test("finishing a session while paused starts the next one paused", () => {
    const session = new GoldSession();
    session.consumeBalance(1_000, START);
    session.consumeBalance(1_200, START + 10 * MIN);
    session.setGameActive(false, START + 10 * MIN);
    session.reset(START + 11 * MIN);
    const paused = session.snapshot(START + 40 * MIN);
    expect(paused.status).toBe("paused");
    expect(paused.elapsedSeconds).toBe(0);
    session.setGameActive(true, START + 40 * MIN);
    const resumed = session.snapshot(START + 45 * MIN);
    expect(resumed.status).toBe("tracking");
    expect(resumed.elapsedSeconds).toBe(5 * 60);
  });

  test("the recent rate survives a restart once the session has paused before", () => {
    const session = new GoldSession();
    session.consumeBalance(1_000, START);
    session.consumeBalance(1_600, START + 10 * MIN);
    session.setGameActive(false, START + 10 * MIN);
    expect(session.snapshot(START + 10 * MIN).recentGoldPerHour).toBe(3_600);

    const restored = GoldSession.restore(session.persisted());
    expect(restored.snapshot(START + 12 * MIN).recentGoldPerHour).toBe(3_600);
    restored.setGameActive(true, START + 12 * MIN);
    expect(restored.snapshot(START + 13 * MIN).recentGoldPerHour).toBeCloseTo(600 / 11 * 60, 5); // 600 over 11 played minutes
  });

  test("finishing a session archives played time, not wall time", () => {
    const session = new GoldSession();
    session.consumeBalance(1_000, START);
    session.consumeBalance(1_200, START + 10 * MIN);
    session.setGameActive(false, START + 10 * MIN);
    session.reset(START + 3 * 60 * MIN);
    const archived = session.snapshot(START + 3 * 60 * MIN).previousSessions[0]!;
    expect(archived.elapsedSeconds).toBe(10 * 60);
    expect(archived.goldPerHour).toBe(1_200);
  });
});
