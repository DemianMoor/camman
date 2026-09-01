// Default-deny authorization map for the OPERATOR role (ClickUp 869et3vm1,
// Phase 2).
//
// ⚠️ THE MAP IS NOT WHAT DENIES. Denial is structural: requireApiMembership()
// refuses an operator outright unless the route hands it the request, and only
// routes the operator may reach do that. A route added tomorrow that never
// calls requireApiAccess(req) denies the operator WITHOUT ANYONE EDITING THIS
// FILE. That is the property that makes "deny by default" true rather than
// aspirational -- a map you must remember to update is a map that will be
// forgotten.
//
// What this file adds on top is a SECOND, explicit statement of intent, so
// that:
//   - the allowed set is reviewable in one place rather than inferred from 259
//     call sites,
//   - scripts/verify-operator-access.ts has something to drive,
//   - scripts/test-route-map-coverage.ts can fail when a route.ts appears on
//     disk that nobody classified.
//
// METHODS MATTER. The registry entries are GET-only on purpose: those route
// files export POST/PATCH from the same module, so a route-level allow would
// have handed the operator write access to Brands and Offers, which the matrix
// makes view-only.
//
// Generated once from the route inventory and then maintained by hand. Adding
// a route means adding a line here AND deciding the methods.

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** `null` = denied for operator. Otherwise the methods they may use. */
export type OperatorAccess = null | { methods: HttpMethod[] };

export const OPERATOR_ROUTE_MAP: Record<string, OperatorAccess> = {
  // ── brands ─────────────────────────────────────────────────────────────
  // Registry is VIEW-ONLY (matrix). GET only -- these files export POST and
  // PATCH too, so a route-level allow would have granted writes.
  "brands": { methods: ["GET"] },
  "brands/[id]": { methods: ["GET"] },
  "brands/[id]/archive": null, // not granted by the access matrix
  "brands/[id]/restore": null, // not granted by the access matrix
  "brands/[id]/short-domains": null, // settings / provider registry -- Owner only
  "brands/[id]/short-domains/[domainId]": null, // settings / provider registry -- Owner only
  "brands/list": { methods: ["GET"] },

  // ── campaigns ─────────────────────────────────────────────────────────────
  // Campaigns & stages: the operator runs these end-to-end. Aggregate
  // counts only -- every contact-level sibling is denied below.
  "campaigns": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/activity": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/activity/messages": null, // contact-level rows or CSV export/import
  "campaigns/[campaignId]/archive": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/behavioral-split": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/behavioral-split/preview": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/click-report": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/drip-config": null, // drip / partner intake -- hidden from the operator
  "campaigns/[campaignId]/drip-followups": null, // drip / partner intake -- hidden from the operator
  "campaigns/[campaignId]/drip-journeys": null, // drip / partner intake -- hidden from the operator
  "campaigns/[campaignId]/drip-numbers": null, // drip / partner intake -- hidden from the operator
  "campaigns/[campaignId]/drip-pause": null, // drip / partner intake -- hidden from the operator
  "campaigns/[campaignId]/duplicate": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/export-all-phones": null, // contact-level rows or CSV export/import
  "campaigns/[campaignId]/export-clickers": null, // contact-level rows or CSV export/import
  "campaigns/[campaignId]/restore": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/send-circuit": null, // compliance control -- Owner only
  "campaigns/[campaignId]/stages": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/stages/[stageId]": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/stages/[stageId]/archive": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/stages/[stageId]/audience-count": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/stages/[stageId]/duplicate": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/stages/[stageId]/export-phones": null, // contact-level rows or CSV export/import
  "campaigns/[campaignId]/stages/[stageId]/import": null, // contact-level rows or CSV export/import
  "campaigns/[campaignId]/stages/[stageId]/import-preview": null, // contact-level rows or CSV export/import
  "campaigns/[campaignId]/stages/[stageId]/imports": null, // contact-level rows or CSV export/import
  "campaigns/[campaignId]/stages/[stageId]/imports/[importId]/revert": null, // contact-level rows or CSV export/import
  "campaigns/[campaignId]/stages/[stageId]/manual-results": null, // contact-level rows or CSV export/import
  // Scheduling half of the send lifecycle: approve, materialize, abort,
  // release. The cron does the actual draining.
  "campaigns/[campaignId]/stages/[stageId]/preflight-abort": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/stages/[stageId]/release-hold": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/stages/[stageId]/restore": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/stages/[stageId]/send": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/stages/[stageId]/send/abort": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/stages/[stageId]/send/approve": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  // 869et3vm1 Phase 3: OPENED to the operator, gated on the volume caps inside
  // the handler. Phase 2 denied it only because no caps existed yet; denying it
  // permanently would mean the hire cannot send, which is the job.
  "campaigns/[campaignId]/stages/[stageId]/send/approve-send": { methods: ["POST"] },
  "campaigns/[campaignId]/stages/[stageId]/send/drain": null, // fires real SMS immediately -- campaigns.drain is manager+ and Phase 3 owns
  // the volume caps
  "campaigns/[campaignId]/stages/[stageId]/send/escalation": null, // contact-level rows or CSV export/import
  "campaigns/[campaignId]/stages/[stageId]/send/kickoff": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/stages/[stageId]/send/materialize-progress": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/stages/[stageId]/send/preflight": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  // 869et3vm1 Phase 3: OPENED to the operator, gated on the volume caps inside
  // the handler. Phase 2 denied it only because no caps existed yet; denying it
  // permanently would mean the hire cannot send, which is the job.
  "campaigns/[campaignId]/stages/[stageId]/send/retry-failed": { methods: ["POST"] },
  "campaigns/[campaignId]/stages/[stageId]/split": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/stages/[stageId]/status": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/stages/audience-preview": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/stages/bulk-status": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/stages/lane-counts": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/status": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/[campaignId]/upload-contacts": null, // contact-level rows or CSV export/import
  "campaigns/audience-preview": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/bulk-status": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "campaigns/list": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },

  // ── carrier ─────────────────────────────────────────────────────────────
  "carrier/triage-queue": null, // cron / webhook / import machinery -- no operator session reaches these
  "carrier/triage-queue/assign": null, // cron / webhook / import machinery -- no operator session reaches these

  // ── clickers ─────────────────────────────────────────────────────────────
  "clickers/[id]": null, // audience block -- contact-level data
  "clickers/bulk-delete": null, // audience block -- contact-level data
  "clickers/export": null, // audience block -- contact-level data
  "clickers/list": null, // audience block -- contact-level data
  "clickers/upload": null, // audience block -- contact-level data

  // ── clicks ─────────────────────────────────────────────────────────────
  "clicks/score-pending": null, // cron / webhook / import machinery -- no operator session reaches these

  // ── contact-attribute-mappings ─────────────────────────────────────────────────────────────
  "contact-attribute-mappings": null, // audience block -- contact-level data
  "contact-attribute-mappings/[id]": null, // audience block -- contact-level data

  // ── contact-groups ─────────────────────────────────────────────────────────────
  "contact-groups": null, // not granted by the access matrix
  "contact-groups/[id]": null, // audience block -- contact-level data
  "contact-groups/[id]/archive": null, // audience block -- contact-level data
  "contact-groups/[id]/contacts": null, // audience block -- contact-level data
  "contact-groups/[id]/contacts/add": null, // audience block -- contact-level data
  "contact-groups/[id]/contacts/remove": null, // audience block -- contact-level data
  "contact-groups/[id]/restore": null, // audience block -- contact-level data
  "contact-groups/list": null, // audience block -- contact-level data

  // ── contacts ─────────────────────────────────────────────────────────────
  "contacts/[id]": null, // audience block -- contact-level data
  "contacts/[id]/archive": null, // audience block -- contact-level data
  "contacts/[id]/restore": null, // audience block -- contact-level data
  // AGGREGATES ONLY (verified: count(*), count(distinct), carrier histogram --
  // no rows, no phones). Explicitly allowed so the operator can see audience
  // size without audience identity.
  "contacts/base-stats": { methods: ["GET"] },
  "contacts/bulk-apply-groups": null, // audience block -- contact-level data
  "contacts/carrier-stats": { methods: ["GET"] },
  "contacts/export": null, // audience block -- contact-level data
  "contacts/import-attributes": null, // audience block -- contact-level data
  "contacts/list": null, // audience block -- contact-level data
  "contacts/statuses/import": null, // audience block -- contact-level data
  "contacts/upload": null, // audience block -- contact-level data

  // ── creatives ─────────────────────────────────────────────────────────────
  // Creatives: view + create + edit. Archive/restore denied -- archive IS
  // delete here, and the matrix says no delete.
  "creatives": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "creatives/[id]": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "creatives/[id]/archive": null, // archive IS delete here -- goes through the deletion queue in Phase 3
  "creatives/[id]/duplicate": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "creatives/[id]/rescore": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "creatives/[id]/restore": null, // archive IS delete here -- goes through the deletion queue in Phase 3
  "creatives/bulk-score": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "creatives/bulk-update": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "creatives/ids": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "creatives/list": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },

  // ── cron ─────────────────────────────────────────────────────────────
  "cron/ahoi-cdr-poll": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/carrier-triage": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/drip-followups": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/drip-monitors": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/drip-routing": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/drip-scheduler": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/lead-enrichment": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/lookup-worker": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/propagate-clickers": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/refresh-contact-stats": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/refresh-offer-group-report": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/report-rollup": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/send-preflight": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/send-scheduled": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/telegram-report": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/tells-monitors": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/tells-sweep": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/textrequest-poll": null, // cron / webhook / import machinery -- no operator session reaches these
  "cron/tracking-monitors": null, // cron / webhook / import machinery -- no operator session reaches these

  // ── dashboard ─────────────────────────────────────────────────────────────
  // Reports/dashboard/today: aggregates only. Provider identity is replaced
  // by a route alias in redactForRole().
  "dashboard/active-campaigns": { methods: ["GET"] },
  "dashboard/active-stages": { methods: ["GET"] },
  "dashboard/daily-activity": { methods: ["GET"] },
  "dashboard/stats": { methods: ["GET"] },

  // ── drip ─────────────────────────────────────────────────────────────
  "drip/why-not-routed": null, // drip / partner intake -- hidden from the operator

  // ── intake ─────────────────────────────────────────────────────────────
  "intake/leads/[token]": null, // drip / partner intake -- hidden from the operator

  // ── keitaro ─────────────────────────────────────────────────────────────
  "keitaro/poll": null, // cron / webhook / import machinery -- no operator session reaches these
  "keitaro/poll-conversions": null, // cron / webhook / import machinery -- no operator session reaches these
  "keitaro/poll-offer-reaches": null, // cron / webhook / import machinery -- no operator session reaches these
  "keitaro/reports": null, // cron / webhook / import machinery -- no operator session reaches these
  "keitaro/results": null, // cron / webhook / import machinery -- no operator session reaches these

  // ── me ─────────────────────────────────────────────────────────────
  // Shell plumbing: /api/me hydrates the auth context, /api/members feeds the
  // campaign assignee picker (ids + roles only, no email).
  "me": { methods: ["GET"] },

  // ── members ─────────────────────────────────────────────────────────────
  // Shell plumbing: /api/me hydrates the auth context, /api/members feeds the
  // campaign assignee picker (ids + roles only, no email).
  "members": { methods: ["GET"] },

  // ── networks ─────────────────────────────────────────────────────────────
  // Registry is VIEW-ONLY (matrix). GET only -- these files export POST and
  // PATCH too, so a route-level allow would have granted writes.
  "networks": { methods: ["GET"] },
  "networks/[id]": { methods: ["GET"] },
  "networks/[id]/archive": null, // not granted by the access matrix
  "networks/[id]/restore": null, // not granted by the access matrix
  "networks/list": { methods: ["GET"] },

  // ── offers ─────────────────────────────────────────────────────────────
  // Registry is VIEW-ONLY (matrix). GET only -- these files export POST and
  // PATCH too, so a route-level allow would have granted writes.
  "offers": { methods: ["GET"] },
  "offers/[offerId]": { methods: ["GET"] },
  "offers/[offerId]/archive": null, // not granted by the access matrix
  "offers/[offerId]/landing-pages": null, // offer destination URLs -- hidden by the matrix
  "offers/[offerId]/landing-pages/[pageId]": null, // offer destination URLs -- hidden by the matrix
  "offers/[offerId]/report": { methods: ["GET"] },
  "offers/[offerId]/restore": null, // not granted by the access matrix
  "offers/list": { methods: ["GET"] },

  // ── opt-ins ─────────────────────────────────────────────────────────────
  "opt-ins/[id]": null, // audience block -- contact-level data
  "opt-ins/bulk-delete": null, // audience block -- contact-level data
  "opt-ins/export": null, // audience block -- contact-level data
  "opt-ins/list": null, // audience block -- contact-level data
  "opt-ins/upload": null, // audience block -- contact-level data

  // ── opt-outs ─────────────────────────────────────────────────────────────
  "opt-outs/[id]": null, // audience block -- contact-level data
  "opt-outs/bulk-delete": null, // audience block -- contact-level data
  "opt-outs/bulk-delete-by-brand": null, // audience block -- contact-level data
  "opt-outs/export": null, // audience block -- contact-level data
  "opt-outs/list": null, // audience block -- contact-level data
  "opt-outs/poll": null, // audience block -- contact-level data
  "opt-outs/upload": null, // audience block -- contact-level data

  // ── partner-keys ─────────────────────────────────────────────────────────────
  "partner-keys": null, // drip / partner intake -- hidden from the operator
  "partner-keys/[keyId]": null, // drip / partner intake -- hidden from the operator
  "partner-keys/[keyId]/report-link": null, // drip / partner intake -- hidden from the operator
  "partner-keys/[keyId]/rotate": null, // drip / partner intake -- hidden from the operator

  // ── provider-phones ─────────────────────────────────────────────────────────────
  // Needed to choose a sending number. Provider identity is redacted to a
  // route alias; the operator selects a Route, never an SSP name.
  "provider-phones/list": { methods: ["GET"] },

  // ── provider-types ─────────────────────────────────────────────────────────────
  "provider-types": null, // settings / provider registry -- Owner only
  "provider-types/[key]/validate": null, // settings / provider registry -- Owner only

  // ── providers ─────────────────────────────────────────────────────────────
  "providers": null, // not granted by the access matrix
  "providers/[providerId]": null, // settings / provider registry -- Owner only
  "providers/[providerId]/api-send": null, // settings / provider registry -- Owner only
  "providers/[providerId]/archive": null, // settings / provider registry -- Owner only
  "providers/[providerId]/credentials": null, // settings / provider registry -- Owner only
  "providers/[providerId]/credentials/[credentialId]": null, // settings / provider registry -- Owner only
  "providers/[providerId]/credentials/[credentialId]/register-callback": null, // settings / provider registry -- Owner only
  "providers/[providerId]/credentials/[credentialId]/register-textrequest-hooks": null, // settings / provider registry -- Owner only
  "providers/[providerId]/credentials/[credentialId]/test-connection": null, // settings / provider registry -- Owner only
  "providers/[providerId]/credentials/test": null, // settings / provider registry -- Owner only
  "providers/[providerId]/opt-out-footer": null, // settings / provider registry -- Owner only
  "providers/[providerId]/phones": null, // settings / provider registry -- Owner only
  "providers/[providerId]/phones/[phoneId]": null, // settings / provider registry -- Owner only
  "providers/[providerId]/phones/[phoneId]/archive": null, // settings / provider registry -- Owner only
  "providers/[providerId]/phones/[phoneId]/restore": null, // settings / provider registry -- Owner only
  "providers/[providerId]/phones/[phoneId]/status": null, // settings / provider registry -- Owner only
  "providers/[providerId]/restore": null, // settings / provider registry -- Owner only
  "providers/[providerId]/send-circuit": null, // settings / provider registry -- Owner only
  "providers/[providerId]/sends-enabled": null, // settings / provider registry -- Owner only
  // The stage form's route picker fetches this. GET only, and the response is
  // aliased by redactForRole -- the operator picks "Route B", never an SSP name.
  // Denying it would leave the operator unable to choose a sending route at all.
  "providers/list": { methods: ["GET"] },

  // ── reports ─────────────────────────────────────────────────────────────
  // Reports/dashboard/today: aggregates only. Provider identity is replaced
  // by a route alias in redactForRole().
  "reports/delivery": { methods: ["GET"] },
  "reports/epc-monitors": null, // maintenance job, not a report
  "reports/partners": null, // drip / partner intake -- hidden from the operator
  "reports/performance": { methods: ["GET"] },
  "reports/rebuild-counted-clickers": null, // maintenance job, not a report

  // ── result-import-mappings ─────────────────────────────────────────────────────────────
  "result-import-mappings": null, // cron / webhook / import machinery -- no operator session reaches these
  "result-import-mappings/[id]": null, // cron / webhook / import machinery -- no operator session reaches these
  "result-import-mappings/[id]/set-default": null, // cron / webhook / import machinery -- no operator session reaches these
  "result-import-mappings/list": null, // cron / webhook / import machinery -- no operator session reaches these

  // ── routing-types ─────────────────────────────────────────────────────────────
  // Registry is VIEW-ONLY (matrix). GET only -- these files export POST and
  // PATCH too, so a route-level allow would have granted writes.
  "routing-types": { methods: ["GET"] },
  "routing-types/[id]": { methods: ["GET"] },
  "routing-types/[id]/archive": null, // not granted by the access matrix
  "routing-types/[id]/restore": null, // not granted by the access matrix
  "routing-types/list": { methods: ["GET"] },

  // ── segment-stats ─────────────────────────────────────────────────────────────
  // Segments: view + create/edit. Every response here is COUNTS ONLY --
  // audience/contacts/export siblings are denied below.
  "segment-stats/refresh-all": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },

  // ── segments ─────────────────────────────────────────────────────────────
  // Segments: view + create/edit. Every response here is COUNTS ONLY --
  // audience/contacts/export siblings are denied below.
  "segments": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "segments/[id]": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "segments/[id]/archive": null, // archive IS delete here -- goes through the deletion queue in Phase 3
  "segments/[id]/audience": null, // contact rows / CSV of contacts
  "segments/[id]/contacts": null, // contact rows / CSV of contacts
  "segments/[id]/contacts/export": null, // contact rows / CSV of contacts
  "segments/[id]/contacts/remove": null, // contact rows / CSV of contacts
  "segments/[id]/contacts/upload": null, // contact rows / CSV of contacts
  "segments/[id]/export-contacts": null, // contact rows / CSV of contacts
  "segments/[id]/refresh-stats": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "segments/[id]/restore": null, // archive IS delete here -- goes through the deletion queue in Phase 3
  "segments/[id]/rules": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "segments/[id]/rules/[ruleId]": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "segments/[id]/rules/preview": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "segments/[id]/rules/reorder": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "segments/export": null, // contact rows / CSV of contacts
  "segments/list": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "segments/overlaps": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },

  // ── sends ─────────────────────────────────────────────────────────────
  "sends/autopilot": null, // compliance control -- Owner only
  "sends/pause": null, // compliance control -- Owner only
  // Reports/dashboard/today: aggregates only. Provider identity is replaced
  // by a route alias in redactForRole().
  "sends/state": { methods: ["GET"] },
  "sends/today": { methods: ["GET"] },

  // ── settings ─────────────────────────────────────────────────────────────
  "settings/notifications": null, // settings / provider registry -- Owner only
  "settings/providers": null, // settings / provider registry -- Owner only
  "settings/sending": null, // settings / provider registry -- Owner only

  // ── short-domains ─────────────────────────────────────────────────────────────
  "short-domains/list": null, // settings / provider registry -- Owner only

  // ── spam ─────────────────────────────────────────────────────────────
  // Spam scoring is part of authoring a creative (the inline check strip).
  "spam/health": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
  "spam/score": { methods: ["GET", "POST", "PATCH", "PUT", "DELETE"] },

  // ── telnyx ─────────────────────────────────────────────────────────────
  "telnyx/lookup/assign-mapping": null, // audience block -- contact-level data
  "telnyx/lookup/batches": null, // audience block -- contact-level data
  "telnyx/lookup/csv-update": null, // audience block -- contact-level data
  "telnyx/lookup/enqueue": null, // audience block -- contact-level data
  "telnyx/lookup/enqueue-group": null, // audience block -- contact-level data
  "telnyx/lookup/enqueue-matched": null, // audience block -- contact-level data
  "telnyx/lookup/group-preview": null, // audience block -- contact-level data
  "telnyx/lookup/group-stats": null, // audience block -- contact-level data
  "telnyx/lookup/group-stats/refresh": null, // audience block -- contact-level data
  "telnyx/lookup/match-preview": null, // audience block -- contact-level data
  "telnyx/lookup/preview": null, // audience block -- contact-level data
  "telnyx/lookup/settings": null, // audience block -- contact-level data
  "telnyx/lookup/unmapped": null, // audience block -- contact-level data

  // ── traffic-types ─────────────────────────────────────────────────────────────
  // Registry is VIEW-ONLY (matrix). GET only -- these files export POST and
  // PATCH too, so a route-level allow would have granted writes.
  "traffic-types": { methods: ["GET"] },
  "traffic-types/[id]": { methods: ["GET"] },
  "traffic-types/[id]/archive": null, // not granted by the access matrix
  "traffic-types/[id]/restore": null, // not granted by the access matrix
  "traffic-types/list": { methods: ["GET"] },

  // ── users ─────────────────────────────────────────────────────────────
  "users/[memberId]": null, // settings / provider registry -- Owner only
  "users/invite": null, // settings / provider registry -- Owner only
  "users/invites/[inviteId]": null, // settings / provider registry -- Owner only
  "users/list": null, // settings / provider registry -- Owner only

  // ── utm-tags ─────────────────────────────────────────────────────────────
  // Registry is VIEW-ONLY (matrix). GET only -- these files export POST and
  // PATCH too, so a route-level allow would have granted writes.
  "utm-tags": { methods: ["GET"] },
  "utm-tags/[id]": { methods: ["GET"] },
  "utm-tags/[id]/archive": null, // not granted by the access matrix
  "utm-tags/[id]/restore": null, // not granted by the access matrix
  "utm-tags/list": { methods: ["GET"] },

  // ── webhooks ─────────────────────────────────────────────────────────────
  "webhooks/ahoi/dlr/[token]": null, // cron / webhook / import machinery -- no operator session reaches these
  "webhooks/ahoi/inbound/[token]": null, // cron / webhook / import machinery -- no operator session reaches these
  "webhooks/tells/dlr/[token]": null, // cron / webhook / import machinery -- no operator session reaches these
  "webhooks/tells/inbound/[token]": null, // cron / webhook / import machinery -- no operator session reaches these
  "webhooks/texthub/opt-out/[token]": null, // cron / webhook / import machinery -- no operator session reaches these
  "webhooks/textrequest/events/[token]": null, // cron / webhook / import machinery -- no operator session reaches these
  "webhooks/textrequest/status/[token]": null, // cron / webhook / import machinery -- no operator session reaches these

};

export const OPERATOR_ALLOWED_COUNT = 84;
export const TOTAL_ROUTE_COUNT = 259;
