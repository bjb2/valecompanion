import type { PickupNotification } from "./pickup-overlay.ts";
import type { LootLine } from "./contracts.ts";

export type CollectorMessage =
  | { type: "ready"; port: number }
  | { type: "play-sound"; name: string }
  | { type: "pickup"; pickup: PickupNotification };

export function parseCollectorMessage(line: string): CollectorMessage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const message = value as Record<string, unknown>;
  if (message.type === "ready" && Number.isInteger(message.port) && Number(message.port) > 0 && Number(message.port) <= 65_535) {
    return { type: "ready", port: Number(message.port) };
  }
  if (message.type === "play-sound" && typeof message.name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(message.name)) {
    return { type: "play-sound", name: message.name };
  }
  if (message.type === "pickup") {
    const pickup = parsePickup(message.pickup);
    if (pickup) return { type: "pickup", pickup };
  }
  return undefined;
}

export function serializeCollectorMessage(message: CollectorMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function parsePickup(value: unknown): PickupNotification | undefined {
  if (!value || typeof value !== "object") return undefined;
  const pickup = value as Record<string, unknown>;
  if (
    !isBoundedInteger(pickup.sequence)
    || !isDisplayText(pickup.name, 160)
    || !isBoundedInteger(pickup.quantity)
    || !isColor(pickup.color)
    || !isIcon(pickup.icon)
    || !(pickup.tag === null || isDisplayText(pickup.tag, 64))
    || !Number.isSafeInteger(pickup.refine) || Number(pickup.refine) < 0 || Number(pickup.refine) > 10_000
    || !Array.isArray(pickup.lines) || pickup.lines.length > 16 || !pickup.lines.every(isPickupLine)
  ) return undefined;
  return {
    sequence: pickup.sequence,
    name: pickup.name,
    icon: pickup.icon,
    quantity: pickup.quantity,
    color: pickup.color,
    tag: pickup.tag,
    refine: Number(pickup.refine),
    lines: pickup.lines,
  };
}

function isBoundedInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function isDisplayText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001F\u007F]/.test(value);
}

function isColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function isIcon(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.webp$/.test(value));
}

function isPickupLine(value: unknown): value is LootLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  return isDisplayText(line.stat, 64)
    && typeof line.rollPct === "number" && Number.isFinite(line.rollPct)
    && (line.printed === null || typeof line.printed === "number" && Number.isFinite(line.printed))
    && typeof line.isChaos === "boolean" && typeof line.over === "boolean";
}
