/**
 * Shared timestamp conversion utilities for EnergiaMind server.
 * Extracted to avoid duplication across telemetry and analytics services (MED-012).
 */

/**
 * Parse a date string or timestamp to a Unix timestamp in seconds.
 * Returns NaN for invalid inputs.
 */
export function toUnixSeconds(input: string | number | Date): number {
  if (input instanceof Date) return Math.floor(input.getTime() / 1000);
  if (typeof input === 'number') return Math.floor(input);
  return Math.floor(new Date(input).getTime() / 1000);
}

/**
 * Build a safe from/to Unix timestamp pair with sensible defaults.
 * Throws if either result is NaN.
 */
export function parseTimeRange(from?: string, to?: string): { fromTs: number; toTs: number } {
  const fromTs = from ? toUnixSeconds(from) : 0;
  const toTs = to ? toUnixSeconds(to) : Math.floor(Date.now() / 1000) + 86400;
  if (isNaN(fromTs) || isNaN(toTs)) throw new Error('Invalid timestamp');
  return { fromTs, toTs };
}
