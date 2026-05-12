// Entity availability flags. Single source of truth for "is this entity built
// yet?" — flipping a flag here enables:
//   - the sidebar nav item (via components/protected/nav-config.ts)
//   - any FK pickers / filters in other entities that reference this one
//     (those gate their fetches on isEntityAvailable(...))
//
// When building a new entity, the last step is flipping its flag to true,
// after schema + API + UI are all working and tested.

export const ENTITY_AVAILABILITY = {
  brands: true,
  offers: true,
  networks: true,        // 5.2
  providers: true,       // 5.3
  routing_types: true,   // 5.4
  traffic_types: true,   // 5.4
  utm_tags: true,        // 5.5
  segment_groups: true,  // 5.6
  contacts: true,        // 6.1
  segments: false,       // 6
  opt_outs: true,        // 6.2
  opt_ins: true,         // 6.2
  clickers: true,        // 6.2
  creatives: false,      // 7
  campaigns: false,      // 7
} as const;

export type EntityKey = keyof typeof ENTITY_AVAILABILITY;

export function isEntityAvailable(entity: EntityKey): boolean {
  return ENTITY_AVAILABILITY[entity];
}
