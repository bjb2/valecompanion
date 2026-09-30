/** @deprecated Import this application-facing helper from spirit-vale-tools-logging. */
export function count(value: number, label: string): string {
  return `${value} ${label}${value === 1 ? "" : "s"}`;
}

/** @deprecated Import this application-facing helper from spirit-vale-tools-logging. */
export function compact(value: number | bigint): string {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** @deprecated Import this application-facing helper from spirit-vale-tools-logging. */
export function warnings(value: number): string {
  return value === 0 ? "" : ` · ${value} skipped`;
}
