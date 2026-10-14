// Client-safe constants for brand landing host/path (0211/0212). The server
// rules live in lib/api/brand-landing.ts, which re-exports these.
export const LANDING_PATH_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const LANDING_PAIR_TAKEN_CODE = "landing_pair_taken";
export const LANDING_PATH_COLLIDES_CODE = "landing_path_collides";
export const BRAND_LANDING_IN_USE_CODE = "brand_landing_in_use";
