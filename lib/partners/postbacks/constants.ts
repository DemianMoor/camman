// Constants only, no imports: the public partner docs page imports these and must not pull in node https/dns.

/** Delay before attempt N+1, indexed by attempts already made minus one. */
export const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 21_600_000, 86_400_000] as const;
export const MAX_ATTEMPTS = 7;
