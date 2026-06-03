import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// External reference to Supabase Auth's users table. Managed by Supabase,
// not by Drizzle. Only the id column is declared because that's all we
// need for foreign-key references.
const authSchema = pgSchema("auth");
const authUsers = authSchema.table("users", {
  id: uuid("id").primaryKey(),
});

export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  created_at: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const org_members = pgTable(
  "org_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    invited_by: uuid("invited_by").references(() => authUsers.id, {
      onDelete: "set null",
    }),
    joined_at: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("org_members_user_org_unique").on(table.user_id, table.org_id),
    index("org_members_org_id_idx").on(table.org_id),
    check(
      "org_members_role_check",
      sql`${table.role} IN ('owner', 'admin', 'manager', 'operator', 'viewer')`,
    ),
  ],
);

export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    token: text("token").notNull().unique(),
    created_by: uuid("created_by")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    accepted_at: timestamp("accepted_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("invites_org_id_idx").on(table.org_id),
    index("invites_email_idx").on(table.email),
    check(
      "invites_role_check",
      sql`${table.role} IN ('admin', 'manager', 'operator', 'viewer')`,
    ),
  ],
);

export const brands = pgTable(
  "brands",
  {
    id: serial("id").primaryKey(),
    brand_id: text("brand_id").notNull().unique(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    short_link_base: text("short_link_base"),
    avatar_url: text("avatar_url"),
    color: text("color"),
    status: text("status").notNull().default("active"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("brands_org_id_idx").on(table.org_id),
    check(
      "brands_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;

export type OrgMember = typeof org_members.$inferSelect;
export type NewOrgMember = typeof org_members.$inferInsert;

export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;

export type Brand = typeof brands.$inferSelect;
export type NewBrand = typeof brands.$inferInsert;

export const affiliate_networks = pgTable(
  "affiliate_networks",
  {
    id: serial("id").primaryKey(),
    network_id: text("network_id").notNull().unique(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url"),
    avatar_url: text("avatar_url"),
    color: text("color"),
    status: text("status").notNull().default("active"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("affiliate_networks_org_id_idx").on(table.org_id),
    check(
      "affiliate_networks_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
  ],
);

export type AffiliateNetwork = typeof affiliate_networks.$inferSelect;
export type NewAffiliateNetwork = typeof affiliate_networks.$inferInsert;

export const offers = pgTable(
  "offers",
  {
    id: serial("id").primaryKey(),
    offer_id: text("offer_id").notNull().unique(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    postfix: text("postfix"),
    base_url: text("base_url"),
    network_id: integer("network_id")
      .notNull()
      .references(() => affiliate_networks.id, {
        // restrict: a network with offers under it can't be deleted out from
        // under them. Archive the offers first, then the network. We can't
        // SET NULL anymore because the column is NOT NULL.
        onDelete: "restrict",
      }),
    payout_model: text("payout_model").notNull().default("cpa"),
    payout_cpa: numeric("payout_cpa", { precision: 12, scale: 4 }),
    payout_revshare: numeric("payout_revshare", { precision: 5, scale: 2 }),
    sales_pages: jsonb("sales_pages")
      .$type<{ label: string; url: string }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    avatar_url: text("avatar_url"),
    color: text("color"),
    status: text("status").notNull().default("active"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("offers_org_id_idx").on(table.org_id),
    index("offers_network_id_idx").on(table.network_id),
    check(
      "offers_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
    check(
      "offers_payout_model_check",
      sql`${table.payout_model} IN ('cpa', 'revshare')`,
    ),
  ],
);

export type Offer = typeof offers.$inferSelect;
export type NewOffer = typeof offers.$inferInsert;

export const sms_providers = pgTable(
  "sms_providers",
  {
    id: serial("id").primaryKey(),
    sms_provider_id: text("sms_provider_id").notNull().unique(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    short_link_supported: boolean("short_link_supported")
      .notNull()
      .default(false),
    short_link_example: text("short_link_example"),
    avatar_url: text("avatar_url"),
    color: text("color"),
    status: text("status").notNull().default("active"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("sms_providers_org_id_idx").on(table.org_id),
    check(
      "sms_providers_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
  ],
);

export type SmsProvider = typeof sms_providers.$inferSelect;
export type NewSmsProvider = typeof sms_providers.$inferInsert;

export const provider_phones = pgTable(
  "provider_phones",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider_id: integer("provider_id")
      .notNull()
      .references(() => sms_providers.id, { onDelete: "cascade" }),
    brand_id: integer("brand_id").references(() => brands.id, {
      onDelete: "set null",
    }),
    phone_number: text("phone_number").notNull(),
    country_code: text("country_code"),
    dial_code: text("dial_code"),
    local_number: text("local_number"),
    cost_per_sms: numeric("cost_per_sms", { precision: 12, scale: 4 })
      .notNull()
      .default("0"),
    // Number category. '10dlc' and 'toll_free' are E.164 phone numbers;
    // 'short_code' is a 5–6 digit numeric code (geo columns stay NULL).
    number_type: text("number_type").notNull().default("10dlc"),
    status: text("status").notNull().default("active"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("provider_phones_org_id_phone_number_unique").on(
      table.org_id,
      table.phone_number,
    ),
    index("provider_phones_provider_id_idx").on(table.provider_id),
    index("provider_phones_brand_id_idx").on(table.brand_id),
    index("provider_phones_org_id_idx").on(table.org_id),
    check(
      "provider_phones_status_check",
      sql`${table.status} IN ('active', 'suspended', 'blocked', 'archived')`,
    ),
    check(
      "provider_phones_number_type_check",
      sql`${table.number_type} IN ('10dlc', 'toll_free', 'short_code')`,
    ),
  ],
);

export type ProviderPhone = typeof provider_phones.$inferSelect;
export type NewProviderPhone = typeof provider_phones.$inferInsert;

export const routing_types = pgTable(
  "routing_types",
  {
    id: serial("id").primaryKey(),
    routing_type_id: text("routing_type_id").notNull().unique(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    color: text("color"),
    status: text("status").notNull().default("active"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("routing_types_org_id_idx").on(table.org_id),
    check(
      "routing_types_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
  ],
);

export type RoutingType = typeof routing_types.$inferSelect;
export type NewRoutingType = typeof routing_types.$inferInsert;

export const traffic_types = pgTable(
  "traffic_types",
  {
    id: serial("id").primaryKey(),
    traffic_type_id: text("traffic_type_id").notNull().unique(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    color: text("color"),
    status: text("status").notNull().default("active"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("traffic_types_org_id_idx").on(table.org_id),
    check(
      "traffic_types_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
  ],
);

export type TrafficType = typeof traffic_types.$inferSelect;
export type NewTrafficType = typeof traffic_types.$inferInsert;

export const utm_tags = pgTable(
  "utm_tags",
  {
    id: serial("id").primaryKey(),
    tag_id: text("tag_id").notNull().unique(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    value_source: text("value_source").notNull(),
    affiliate_network_id: integer("affiliate_network_id").references(
      () => affiliate_networks.id,
      { onDelete: "set null" },
    ),
    color: text("color"),
    status: text("status").notNull().default("active"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("utm_tags_org_id_idx").on(table.org_id),
    index("utm_tags_affiliate_network_id_idx").on(table.affiliate_network_id),
    check(
      "utm_tags_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
  ],
);

export type UtmTag = typeof utm_tags.$inferSelect;
export type NewUtmTag = typeof utm_tags.$inferInsert;

// Contact groups: categorical tags applied directly to contacts. A contact
// may have multiple groups. Renamed from `segment_groups` in 0031; rows are
// preserved (existing IDs unchanged). The associated junction was also
// flipped from segment↔group to contact↔group — see contact_contact_groups.
export const contact_groups = pgTable(
  "contact_groups",
  {
    id: serial("id").primaryKey(),
    contact_group_id: text("contact_group_id").notNull().unique(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    color: text("color"),
    status: text("status").notNull().default("active"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("segment_groups_org_id_idx").on(table.org_id),
    check(
      "contact_groups_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
  ],
);

export type ContactGroup = typeof contact_groups.$inferSelect;
export type NewContactGroup = typeof contact_groups.$inferInsert;

// Contacts: central phone registry. UUID PK (not serial) because this table
// will grow to millions of rows; UUIDs distribute better across shards/replicas
// if that ever becomes relevant. Do not mirror this choice for small lookup
// entities — those use serial.
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    phone_number: text("phone_number").notNull(),
    is_archived: boolean("is_archived").notNull().default(false),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("contacts_org_id_phone_number_unique").on(
      table.org_id,
      table.phone_number,
    ),
    index("contacts_org_id_idx").on(table.org_id),
    index("contacts_org_id_is_archived_idx").on(
      table.org_id,
      table.is_archived,
    ),
  ],
);

export type Contact = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;

// Opt-Outs: append-only records of suppressions. Multiple opt_out rows can
// exist for the same contact over time (different sources, different brand
// scopes). Junction tables link each opt_out to one or more brands/providers.
//
// `reason` distinguishes the WHY:
//   - 'opt_out'  — the recipient said STOP (brand-scoped via opt_out_brands).
//   - 'scrubbed' — provider rejected the number as non-mobile. Universal
//                  (no opt_out_brands row). Originates from stage results.
//   - 'bounced'  — carrier rejected delivery. Universal. Originates from
//                  stage results.
//   - 'suppressed' — Global Suppression. Universal (no opt_out_brands row).
//                  A contact-level status set via the Contacts status import.
// All four exclude the contact from future audience snapshots — the
// audience query checks for any opt_outs row regardless of reason.
export const opt_outs = pgTable(
  "opt_outs",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contact_id: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    phone_number: text("phone_number").notNull(),
    source: text("source"),
    reason: text("reason").notNull().default("opt_out"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("opt_outs_org_id_idx").on(table.org_id),
    index("opt_outs_contact_id_idx").on(table.contact_id),
    index("opt_outs_phone_number_idx").on(table.phone_number),
    check(
      "opt_outs_reason_check",
      sql`${table.reason} IN ('opt_out', 'scrubbed', 'bounced', 'suppressed')`,
    ),
  ],
);

export type OptOut = typeof opt_outs.$inferSelect;
export type NewOptOut = typeof opt_outs.$inferInsert;

export const opt_out_brands = pgTable(
  "opt_out_brands",
  {
    opt_out_id: integer("opt_out_id")
      .notNull()
      .references(() => opt_outs.id, { onDelete: "cascade" }),
    brand_id: integer("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("opt_out_brands_pkey").on(table.opt_out_id, table.brand_id),
    index("opt_out_brands_brand_id_idx").on(table.brand_id),
  ],
);

export const opt_out_providers = pgTable(
  "opt_out_providers",
  {
    opt_out_id: integer("opt_out_id")
      .notNull()
      .references(() => opt_outs.id, { onDelete: "cascade" }),
    provider_id: integer("provider_id")
      .notNull()
      .references(() => sms_providers.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("opt_out_providers_pkey").on(table.opt_out_id, table.provider_id),
    index("opt_out_providers_provider_id_idx").on(table.provider_id),
  ],
);

// Opt-Ins: single brand/provider per row (no junctions; simpler than opt_outs).
export const opt_ins = pgTable(
  "opt_ins",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contact_id: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    phone_number: text("phone_number").notNull(),
    brand_id: integer("brand_id").references(() => brands.id, {
      onDelete: "set null",
    }),
    provider_id: integer("provider_id").references(() => sms_providers.id, {
      onDelete: "set null",
    }),
    source: text("source"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("opt_ins_org_id_idx").on(table.org_id),
    index("opt_ins_contact_id_idx").on(table.contact_id),
    index("opt_ins_phone_number_idx").on(table.phone_number),
    index("opt_ins_brand_id_idx").on(table.brand_id),
    index("opt_ins_provider_id_idx").on(table.provider_id),
  ],
);

export type OptIn = typeof opt_ins.$inferSelect;
export type NewOptIn = typeof opt_ins.$inferInsert;

// Clickers: engagement records. brand_id is required (we always know which
// brand was clicked). Optional links to provider/provider_phone/offer for
// richer context.
export const clickers = pgTable(
  "clickers",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contact_id: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    phone_number: text("phone_number").notNull(),
    brand_id: integer("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    provider_id: integer("provider_id").references(() => sms_providers.id, {
      onDelete: "set null",
    }),
    provider_phone_id: integer("provider_phone_id").references(
      () => provider_phones.id,
      { onDelete: "set null" },
    ),
    offer_id: integer("offer_id").references(() => offers.id, {
      onDelete: "set null",
    }),
    source: text("source"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("clickers_org_id_idx").on(table.org_id),
    index("clickers_contact_id_idx").on(table.contact_id),
    index("clickers_phone_number_idx").on(table.phone_number),
    index("clickers_brand_id_idx").on(table.brand_id),
    index("clickers_provider_id_idx").on(table.provider_id),
    index("clickers_offer_id_idx").on(table.offer_id),
  ],
);

export type Clicker = typeof clickers.$inferSelect;
export type NewClicker = typeof clickers.$inferInsert;

// Segments: named lists of contacts. Membership lives in segment_contacts;
// group membership lives in segment_segment_groups (many-to-many).
// `original_name` preserves the import-time name if the user renames the
// segment later (useful when reconciling external systems).
export const segments = pgTable(
  "segments",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    segment_id: text("segment_id").notNull().unique(),
    name: text("name").notNull(),
    original_name: text("original_name"),
    status: text("status").notNull().default("active"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    // When true, the segment's effective audience subtracts any contacts
    // already snapshotted into a campaign_audience_pool for a campaign
    // with status='active'. Lets the operator reserve contacts to a
    // single in-flight campaign without manual exclusion lists.
    exclude_in_use_contacts: boolean("exclude_in_use_contacts")
      .notNull()
      .default(false),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("segments_org_id_idx").on(table.org_id),
    check(
      "segments_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
  ],
);

export type Segment = typeof segments.$inferSelect;
export type NewSegment = typeof segments.$inferInsert;

// Junction: contacts ↔ contact_groups. Many-to-many tags applied directly
// to contacts (replaces the old segment_segment_groups junction).
export const contact_contact_groups = pgTable(
  "contact_contact_groups",
  {
    contact_id: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    contact_group_id: integer("contact_group_id")
      .notNull()
      .references(() => contact_groups.id, { onDelete: "cascade" }),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.contact_id, table.contact_group_id] }),
    index("contact_contact_groups_group_id_idx").on(table.contact_group_id),
    index("contact_contact_groups_org_id_idx").on(table.org_id),
  ],
);

export type ContactContactGroup = typeof contact_contact_groups.$inferSelect;
export type NewContactContactGroup = typeof contact_contact_groups.$inferInsert;

export const segment_contacts = pgTable(
  "segment_contacts",
  {
    segment_id: integer("segment_id")
      .notNull()
      .references(() => segments.id, { onDelete: "cascade" }),
    contact_id: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("segment_contacts_pkey").on(table.segment_id, table.contact_id),
    index("segment_contacts_contact_id_idx").on(table.contact_id),
    index("segment_contacts_org_id_idx").on(table.org_id),
  ],
);

export type SegmentContact = typeof segment_contacts.$inferSelect;
export type NewSegmentContact = typeof segment_contacts.$inferInsert;

// Maintained aggregate counts per segment. total_count is kept in sync by
// the segment_contacts AFTER INSERT/DELETE trigger. The opt_out_count /
// opt_in_count / clicker_count fields are NOT trigger-maintained — they're
// refreshed on demand via /api/segments/[id]/refresh-stats. See the trigger
// migration for rationale.
export const segment_stats = pgTable(
  "segment_stats",
  {
    segment_id: integer("segment_id")
      .primaryKey()
      .references(() => segments.id, { onDelete: "cascade" }),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    total_count: integer("total_count").notNull().default(0),
    opt_out_count: integer("opt_out_count").notNull().default(0),
    opt_in_count: integer("opt_in_count").notNull().default(0),
    clicker_count: integer("clicker_count").notNull().default(0),
    // Nullable: only populated by /refresh-stats when segment rules exist.
    // UI renders "—" if null. Separate from total_count because total_count
    // is maintained by a cheap per-row trigger; the rule-filtered count
    // requires running the full rules evaluation query.
    rule_filtered_count: integer("rule_filtered_count"),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("segment_stats_org_id_idx").on(table.org_id)],
);

export type SegmentStats = typeof segment_stats.$inferSelect;
export type NewSegmentStats = typeof segment_stats.$inferInsert;

// Segment rules: declarative filters on segment audiences. Zero rules =
// no filtering. Rules combine with AND. See lib/segment-rules-eval.ts.
export const segment_rules = pgTable(
  "segment_rules",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    segment_id: integer("segment_id")
      .notNull()
      .references(() => segments.id, { onDelete: "cascade" }),
    rule_type: text("rule_type").notNull(),
    operator: text("operator").notNull(),
    value: jsonb("value"),
    position: integer("position").notNull(),
    is_active: boolean("is_active").notNull().default(true),
    // Joins this rule to the running AND/OR of the prior rules. The
    // first rule (lowest position) has no prior context; its combinator
    // is read but ignored at eval time.
    combinator: text("combinator").notNull().default("and"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("segment_rules_segment_position_idx").on(
      table.segment_id,
      table.position,
    ),
    index("segment_rules_org_id_idx").on(table.org_id),
    check(
      "segment_rules_rule_type_check",
      sql`${table.rule_type} IN (
        'is_clicker_any_brand',
        'is_clicker_for_brand',
        'is_clicker_for_offer',
        'is_optin_any_brand',
        'is_optin_for_brand',
        'is_optout_for_brand',
        'contact_added_in_last_n_days',
        'contact_added_more_than_n_days_ago',
        'joined_segment_in_last_n_days',
        'joined_segment_more_than_n_days_ago',
        'member_of_segment'
      )`,
    ),
    check(
      "segment_rules_operator_check",
      sql`${table.operator} IN ('is', 'is_not')`,
    ),
    check(
      "segment_rules_combinator_check",
      sql`${table.combinator} IN ('and', 'or')`,
    ),
  ],
);

export type SegmentRule = typeof segment_rules.$inferSelect;
export type NewSegmentRule = typeof segment_rules.$inferInsert;

// Creatives: SMS copy linked to an Offer, optionally scoped to a Provider
// + Brand. `slug` is auto-generated and used in short-link construction.
// `creative_id` is an optional human-friendly identifier for external
// tracking systems.
// Creatives: SMS copy templates. Many-to-many with offers via the
// creative_offers junction (or applies_to_all_offers=true for an
// org-wide creative). No direct provider/brand association — those live
// at the stage level. Status is just active|archived; no state machine.
export const creatives = pgTable(
  "creatives",
  {
    id: serial("id").primaryKey(),
    creative_id: text("creative_id").unique(),
    slug: text("slug").notNull().unique(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    quality: text("quality").notNull().default("unknown"),
    sequence_placement: text("sequence_placement").notNull().default("unknown"),
    applies_to_all_offers: boolean("applies_to_all_offers")
      .notNull()
      .default(false),
    // Mirrored from spam_scores on save. spam_score is 0-100 from the
    // provider; spam_label is the binary verdict (score > 50 ⇒ 'spam').
    // spam_score_error is set when scoring failed; in that case score /
    // label / model_id stay NULL. Re-scoring via PATCH or the dedicated
    // /rescore endpoint overwrites both. The shared spam_scores cache is
    // still the source of truth for cross-creative deduping; these
    // columns exist for fast list rendering and per-row UI without a
    // join.
    spam_score: integer("spam_score"),
    spam_label: text("spam_label"),
    spam_scored_at: timestamp("spam_scored_at", { withTimezone: true }),
    spam_model_id: text("spam_model_id"),
    spam_score_error: text("spam_score_error"),
    status: text("status").notNull().default("active"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("creatives_org_id_idx").on(table.org_id),
    index("creatives_status_idx").on(table.status),
    check(
      "creatives_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
    check(
      "creatives_quality_check",
      sql`${table.quality} IN ('high', 'average', 'poor', 'unknown')`,
    ),
    check(
      "creatives_sequence_placement_check",
      sql`${table.sequence_placement} IN ('warmup', '1st', '2nd', '3rd', 'any', 'unknown')`,
    ),
    check(
      "creatives_spam_score_check",
      sql`${table.spam_score} IS NULL OR (${table.spam_score} >= 0 AND ${table.spam_score} <= 100)`,
    ),
    check(
      "creatives_spam_label_check",
      sql`${table.spam_label} IS NULL OR ${table.spam_label} IN ('ham', 'spam')`,
    ),
  ],
);

export type Creative = typeof creatives.$inferSelect;
export type NewCreative = typeof creatives.$inferInsert;

// Junction: creatives ↔ offers. A creative with applies_to_all_offers=true
// is org-wide and doesn't need junction rows (though existing rows are
// preserved on toggle — see PATCH semantics).
export const creative_offers = pgTable(
  "creative_offers",
  {
    creative_id: integer("creative_id")
      .notNull()
      .references(() => creatives.id, { onDelete: "cascade" }),
    offer_id: integer("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.creative_id, table.offer_id] }),
    index("creative_offers_offer_id_idx").on(table.offer_id),
    index("creative_offers_org_id_idx").on(table.org_id),
  ],
);

export type CreativeOffer = typeof creative_offers.$inferSelect;
export type NewCreativeOffer = typeof creative_offers.$inferInsert;

// Campaigns: long-running containers for SMS-send sequences. The audience
// is frozen at activation — see campaign_audience_pool below. Drafts can
// be saved empty; name + brand + offer are enforced at the API layer when
// transitioning out of draft. FK constraints still apply when non-null;
// deleting a referenced brand/offer is blocked by ON DELETE RESTRICT.
export const campaigns = pgTable(
  "campaigns",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    human_id: text("human_id"),
    name: text("name"),
    notes: text("notes"),
    brand_id: integer("brand_id").references(() => brands.id, {
      onDelete: "restrict",
    }),
    offer_id: integer("offer_id").references(() => offers.id, {
      onDelete: "restrict",
    }),
    routing_type_id: integer("routing_type_id").references(
      () => routing_types.id,
      { onDelete: "set null" },
    ),
    traffic_type_id: integer("traffic_type_id").references(
      () => traffic_types.id,
      { onDelete: "set null" },
    ),
    assigned_to_user_id: uuid("assigned_to_user_id").references(
      () => authUsers.id,
      { onDelete: "set null" },
    ),
    created_by_user_id: uuid("created_by_user_id").references(
      () => authUsers.id,
      { onDelete: "set null" },
    ),
    audience_segment_ids: integer("audience_segment_ids")
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    audience_contact_group_ids: integer("audience_contact_group_ids")
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    audience_filters: jsonb("audience_filters")
      .$type<{
        include_no_status?: boolean;
        include_opt_in?: boolean;
        include_clickers?: boolean;
        include_not_clicked?: boolean;
      }>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    audience_snapshot_count: integer("audience_snapshot_count")
      .notNull()
      .default(0),
    // Cap is applied at activation time via ORDER BY RANDOM() LIMIT.
    // NULL = no cap (use the full matching audience). A cap larger than
    // the matching pool is a no-op. Frozen with the rest of the audience
    // after the draft → active transition.
    audience_cap: integer("audience_cap"),
    // When true, the snapshot excludes any contact already snapshotted into
    // another campaign with status='active' (across the WHOLE audience —
    // segments and contact groups). The cap then samples from the unused
    // pool only, falling back to all-unused when fewer exist than the cap.
    // Defaults true (on). Broader counterpart to segments.exclude_in_use_contacts;
    // frozen with the rest of the audience after draft → active.
    exclude_in_use_contacts: boolean("exclude_in_use_contacts")
      .notNull()
      .default(true),
    start_date: date("start_date"),
    end_date: date("end_date"),
    status: text("status").notNull().default("draft"),
    previous_status: text("previous_status"),
    status_changed_at: timestamp("status_changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Auto-generated, immutable, structured ID for external analytics
    // (e.g. `5_14296_051526_1` = brand_5, offer_14296, May 15 2026 ET,
    // first of the day). NULL until both brand_id and offer_id are set.
    // Once non-NULL it never changes — see lib/tracking-id.ts.
    tracking_id: text("tracking_id"),
    // Which link the send path reads at send time (see CLAUDE.md / the link
    // shortener module). 'manual' (default) → the operator-pasted
    // campaign_stages.short_url/full_url, exactly as before. 'tracked' → the
    // send path mints a unique per-recipient link via lib/links/mint-link.ts
    // instead. Switching modes never touches the manual short_url/full_url
    // fields, so toggling back restores the original behavior unchanged.
    // A campaign may only be set to 'tracked' when its brand has an active
    // short_domains row (guarded in the API). Per-campaign, not per-stage.
    link_mode: text("link_mode").notNull().default("manual"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("campaigns_org_id_slug_unique").on(table.org_id, table.slug),
    index("campaigns_org_id_idx").on(table.org_id),
    index("campaigns_brand_id_idx").on(table.brand_id),
    index("campaigns_offer_id_idx").on(table.offer_id),
    index("campaigns_assigned_to_user_id_idx").on(table.assigned_to_user_id),
    index("campaigns_status_idx").on(table.status),
    check(
      "campaigns_status_check",
      sql`${table.status} IN ('draft', 'active', 'paused', 'completed', 'archived')`,
    ),
    check(
      "campaigns_link_mode_check",
      sql`${table.link_mode} IN ('manual', 'tracked')`,
    ),
  ],
);

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;

// Campaign stages: actual SMS-send events under a campaign. stage_number is
// auto-assigned by a BEFORE INSERT trigger (see migration) — clients can
// omit it. The UNIQUE constraint on (campaign_id, stage_number) is a
// backstop against the rare concurrent-insert race; one of the racers will
// fail and the client should retry.
export const campaign_stages = pgTable(
  "campaign_stages",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    campaign_id: integer("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    stage_number: integer("stage_number").notNull(),
    label: text("label"),
    creative_id: integer("creative_id").references(() => creatives.id, {
      onDelete: "set null",
    }),
    sms_provider_id: integer("sms_provider_id").references(
      () => sms_providers.id,
      { onDelete: "set null" },
    ),
    provider_phone_id: integer("provider_phone_id").references(
      () => provider_phones.id,
      { onDelete: "set null" },
    ),
    sales_page_label: text("sales_page_label"),
    // Optional tracking + send URLs. full_url is metadata only (used for
    // tracking the link with campaign IDs externally); short_url, when
    // present, is rendered into the SMS preview on its own line between
    // the creative text and the stop text.
    short_url: text("short_url"),
    full_url: text("full_url"),
    // Ordered list of utm_tags.id selected for this stage's Full URL
    // link-builder. The selected tags append `&<label>=<value_source>` to
    // full_url (see lib/stage-url.ts). Stored as an ordered jsonb int array;
    // FK ownership is verified in the API (jsonb can't carry a FK).
    utm_tag_ids: jsonb("utm_tag_ids")
      .$type<number[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    stop_text: text("stop_text").notNull().default("Stop to END"),
    include_clickers: boolean("include_clickers").notNull().default(false),
    exclude_clickers: boolean("exclude_clickers").notNull().default(false),
    include_no_status: boolean("include_no_status").notNull().default(true),
    scheduled_at: timestamp("scheduled_at", { withTimezone: true }),
    sent_at: timestamp("sent_at", { withTimezone: true }),
    status_changed_at: timestamp("status_changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    previous_status: text("previous_status"),
    status: text("status").notNull().default("draft"),
    sms_count: integer("sms_count").notNull().default(0),
    total_cost: numeric("total_cost", { precision: 12, scale: 4 })
      .notNull()
      .default("0"),
    delivered_count: integer("delivered_count").notNull().default(0),
    opt_out_count: integer("opt_out_count").notNull().default(0),
    // click_count is the "Clicker 1st Day" bucket (clicks recorded from the
    // initial / day-1 results report). late_click_count holds clicks recorded
    // from follow-up ("late") clicker reports uploaded on subsequent days,
    // deduped against every clicker already recorded for the stage so the
    // same number never counts twice. See the import route's clicker_phase.
    click_count: integer("click_count").notNull().default(0),
    late_click_count: integer("late_click_count").notNull().default(0),
    scrubbed_count: integer("scrubbed_count").notNull().default(0),
    bounced_count: integer("bounced_count").notNull().default(0),
    // Checkout clicks and sales are manual-only for now (no CSV path yet).
    checkout_click_count: integer("checkout_click_count")
      .notNull()
      .default(0),
    sales_count: integer("sales_count").notNull().default(0),
    // Offer payout-per-sale (CPA) snapshotted at the moment the sales count
    // was last entered, so revenue/ROI reflect the offer's payout "on the
    // date the sale was mapped" and don't shift if the offer is edited
    // later. NULL when there are no sales (or the offer had no CPA payout).
    sales_payout_each: numeric("sales_payout_each", {
      precision: 12,
      scale: 4,
    }),
    notes: text("notes"),
    // A/B split partitioning. Both NULL ⇒ stage targets the entire
    // qualifying audience. When set, split_index is 1..split_total and
    // the stage's audience is filtered by
    // `mod(hashtext(contact_id::text), split_total) = split_index - 1`,
    // so the same contact always lands in the same bucket for a given
    // total. Set only by POST /api/campaigns/[campaignId]/stages/[stageId]/split;
    // immutable via PATCH like tracking_id. See db/migrations/0039_stage_splits.sql.
    split_index: integer("split_index"),
    split_total: integer("split_total"),
    // Auto-generated, immutable tracking ID. Format:
    // `<campaign_tracking_id>_s<stage_number>_c<creative_id>`. NULL until
    // the parent campaign has a tracking_id AND the stage has a
    // creative_id. Generated on insert; never regenerated when creative_id
    // is changed later. See lib/tracking-id.ts.
    tracking_id: text("tracking_id"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("campaign_stages_campaign_id_stage_number_unique").on(
      table.campaign_id,
      table.stage_number,
    ),
    index("campaign_stages_org_id_idx").on(table.org_id),
    index("campaign_stages_campaign_id_idx").on(table.campaign_id),
    index("campaign_stages_creative_id_idx").on(table.creative_id),
    index("campaign_stages_sms_provider_id_idx").on(table.sms_provider_id),
    index("campaign_stages_status_idx").on(table.status),
    check(
      "campaign_stages_status_check",
      sql`${table.status} IN ('draft', 'pending', 'sent', 'success', 'cancelled', 'failed', 'archived')`,
    ),
    check(
      "campaign_stages_clickers_mutex",
      sql`NOT (${table.include_clickers} AND ${table.exclude_clickers})`,
    ),
    check(
      "campaign_stages_split_pair_check",
      sql`(${table.split_index} IS NULL AND ${table.split_total} IS NULL)
          OR (${table.split_index} BETWEEN 1 AND ${table.split_total}
              AND ${table.split_total} BETWEEN 2 AND 1000)`,
    ),
  ],
);

export type CampaignStage = typeof campaign_stages.$inferSelect;
export type NewCampaignStage = typeof campaign_stages.$inferInsert;

// Per-(org, brand, offer, date) counter table backing the campaign
// tracking_id sequence. Rows are inserted on demand via an atomic
// INSERT ... ON CONFLICT DO UPDATE ... RETURNING next_seq - 1, which
// reserves the next sequence number in a single statement (no race
// between SELECT and INSERT). See lib/tracking-id.ts.
//
// date_et is the campaign's created_at date in America/New_York (the
// project-wide CAMPAIGN_TIMEZONE). Stored as DATE so daily partitioning
// of the key space is unambiguous regardless of how the timestamp was
// originally captured.
export const campaign_tracking_counters = pgTable(
  "campaign_tracking_counters",
  {
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    brand_id: integer("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    offer_id: integer("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    date_et: date("date_et").notNull(),
    next_seq: integer("next_seq").notNull().default(1),
  },
  (table) => [
    primaryKey({
      columns: [table.org_id, table.brand_id, table.offer_id, table.date_et],
    }),
  ],
);

export type CampaignTrackingCounter =
  typeof campaign_tracking_counters.$inferSelect;
export type NewCampaignTrackingCounter =
  typeof campaign_tracking_counters.$inferInsert;

// Frozen audience pool. Populated at campaign creation by snapshotAudience()
// and never mutated thereafter — the entire point is that adding a contact
// to a referenced segment later doesn't retroactively expand the campaign's
// reach. Stage exports query this pool, then apply stage-level filters
// against the per-row snapshot booleans plus a live opt_outs exclusion.
export const campaign_audience_pool = pgTable(
  "campaign_audience_pool",
  {
    campaign_id: integer("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    contact_id: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    was_clicker_at_snapshot: boolean("was_clicker_at_snapshot")
      .notNull()
      .default(false),
    was_opt_in_at_snapshot: boolean("was_opt_in_at_snapshot")
      .notNull()
      .default(false),
    was_no_status_at_snapshot: boolean("was_no_status_at_snapshot")
      .notNull()
      .default(false),
  },
  (table) => [
    unique("campaign_audience_pool_pkey").on(
      table.campaign_id,
      table.contact_id,
    ),
    index("campaign_audience_pool_contact_id_idx").on(table.contact_id),
    index("campaign_audience_pool_org_id_idx").on(table.org_id),
  ],
);

export type CampaignAudiencePool =
  typeof campaign_audience_pool.$inferSelect;
export type NewCampaignAudiencePool =
  typeof campaign_audience_pool.$inferInsert;

// ============ Stage results imports ============
// Per-provider column-mapping templates. Each provider ships a different
// CSV; users configure the mapping once and reuse it. is_default is enforced
// to be unique per (org, provider) via a partial unique index.
export const result_import_mappings = pgTable(
  "result_import_mappings",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    sms_provider_id: integer("sms_provider_id")
      .notNull()
      .references(() => sms_providers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    is_default: boolean("is_default").notNull().default(false),
    mapping: jsonb("mapping").notNull(),
    status_value_map: jsonb("status_value_map"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("result_import_mappings_org_provider_idx").on(
      table.org_id,
      table.sms_provider_id,
    ),
  ],
);

export type ResultImportMapping = typeof result_import_mappings.$inferSelect;
export type NewResultImportMapping =
  typeof result_import_mappings.$inferInsert;

// One row per import event. Permanent (no hard delete) so the audit trail
// survives even after revert. reverted_at + reverted_by_user_id are set on
// revert; the related stage_result_rows are deleted (via CASCADE on the
// revert path's delete from stage_result_rows).
export const stage_results_imports = pgTable(
  "stage_results_imports",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    campaign_id: integer("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    stage_id: integer("stage_id")
      .notNull()
      .references(() => campaign_stages.id, { onDelete: "cascade" }),
    imported_by_user_id: uuid("imported_by_user_id").references(
      () => authUsers.id,
      { onDelete: "set null" },
    ),
    mapping_id: integer("mapping_id").references(
      () => result_import_mappings.id,
      { onDelete: "set null" },
    ),
    filename: text("filename"),
    submitted_rows: integer("submitted_rows").notNull(),
    processed_rows: integer("processed_rows").notNull(),
    delivered_added: integer("delivered_added").notNull().default(0),
    failed_added: integer("failed_added").notNull().default(0),
    optouts_added: integer("optouts_added").notNull().default(0),
    clickers_added: integer("clickers_added").notNull().default(0),
    // Clicks added by a "late" clicker report (clicker_phase = 'late'). Kept
    // separate from clickers_added (day-1) so revert can undo the right
    // stage counter. Always 0 for day-1 imports.
    late_clickers_added: integer("late_clickers_added").notNull().default(0),
    scrubbed_added: integer("scrubbed_added").notNull().default(0),
    bounced_added: integer("bounced_added").notNull().default(0),
    total_cost_added: numeric("total_cost_added", { precision: 12, scale: 4 })
      .notNull()
      .default("0"),
    // Which clicker bucket this import fed. 'day1' (or NULL for legacy rows)
    // = a normal full-results import; 'late' = a clicker-only follow-up that
    // only touched late_click_count. Revert branches on this.
    clicker_phase: text("clicker_phase"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reverted_at: timestamp("reverted_at", { withTimezone: true }),
    reverted_by_user_id: uuid("reverted_by_user_id").references(
      () => authUsers.id,
      { onDelete: "set null" },
    ),
  },
  (table) => [
    index("stage_results_imports_org_stage_created_idx").on(
      table.org_id,
      table.stage_id,
      table.created_at,
    ),
    check(
      "stage_results_imports_clicker_phase_check",
      sql`${table.clicker_phase} IS NULL OR ${table.clicker_phase} IN ('day1', 'late')`,
    ),
  ],
);

export type StageResultsImport = typeof stage_results_imports.$inferSelect;
export type NewStageResultsImport =
  typeof stage_results_imports.$inferInsert;

// Per-row record of what an import wrote. UNIQUE(stage_id, phone_number)
// is the dedup key: re-importing the same CSV will hit conflicts and skip.
// created_opt_out_id / created_clicker_id reference the resulting opt_out
// or clicker — either newly inserted by this import OR pre-existing (e.g.
// a prior import already created it). On revert, the opt_out/clicker is
// kept if any other non-reverted row still references it; otherwise it's
// deleted alongside this row. This is the cross-import preservation rule.
export const stage_result_rows = pgTable(
  "stage_result_rows",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    import_id: integer("import_id")
      .notNull()
      .references(() => stage_results_imports.id, { onDelete: "cascade" }),
    stage_id: integer("stage_id")
      .notNull()
      .references(() => campaign_stages.id, { onDelete: "cascade" }),
    phone_number: text("phone_number").notNull(),
    contact_id: uuid("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    outcome: text("outcome").notNull(),
    cost: numeric("cost", { precision: 12, scale: 4 }),
    raw_row: jsonb("raw_row"),
    created_opt_out_id: integer("created_opt_out_id").references(
      () => opt_outs.id,
      { onDelete: "set null" },
    ),
    created_clicker_id: integer("created_clicker_id").references(
      () => clickers.id,
      { onDelete: "set null" },
    ),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("stage_result_rows_stage_phone_unique").on(
      table.stage_id,
      table.phone_number,
    ),
    index("stage_result_rows_import_id_idx").on(table.import_id),
    index("stage_result_rows_stage_outcome_idx").on(
      table.stage_id,
      table.outcome,
    ),
    check(
      "stage_result_rows_outcome_check",
      sql`${table.outcome} IN ('delivered', 'failed', 'optout', 'clicker', 'scrubbed', 'bounced', 'noop')`,
    ),
  ],
);

export type StageResultRow = typeof stage_result_rows.$inferSelect;
export type NewStageResultRow = typeof stage_result_rows.$inferInsert;

// ============ Spam scoring cache ============
// Append-only cache keyed by (org_id, text_hash, provider). Re-scoring the
// same text is a cache hit unless force=true. Different providers can
// score the same text independently. See lib/spam/.
export const spam_scores = pgTable(
  "spam_scores",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    text_hash: text("text_hash").notNull(),
    text_length: integer("text_length").notNull(),
    score: integer("score").notNull(),
    label: text("label").notNull(),
    confidence: real("confidence"),
    provider: text("provider").notNull(),
    model_version: text("model_version"),
    raw_response: jsonb("raw_response"),
    latency_ms: integer("latency_ms"),
    error: text("error"),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("spam_scores_org_hash_provider_unique").on(
      table.org_id,
      table.text_hash,
      table.provider,
    ),
    index("spam_scores_org_created_idx").on(table.org_id, table.created_at),
    index("spam_scores_score_idx").on(table.score),
    check(
      "spam_scores_score_check",
      sql`${table.score} >= 0 AND ${table.score} <= 100`,
    ),
    check(
      "spam_scores_label_check",
      sql`${table.label} IN ('ham', 'suspicious', 'spam')`,
    ),
  ],
);

export type SpamScore = typeof spam_scores.$inferSelect;
export type NewSpamScore = typeof spam_scores.$inferInsert;

// ============ Link shortener + click tracker ============
// First piece of the TextHub SMS integration. In 'tracked' campaigns the
// send path mints a unique short link per recipient (one per "message",
// keyed by a caller-supplied send_token); a click resolves 1:1 to
// (contact, campaign, stage, creative, destination) for attribution.
// Bot/prefetch clicks are classified, never deleted — filtered at report
// time. See db/migrations/0048_link_shortener.sql and lib/links/mint-link.ts.

// A brand's short-link host(s), e.g. "go.brandx.co". A campaign can only be
// switched to link_mode='tracked' when its brand has an active row here.
export const short_domains = pgTable(
  "short_domains",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    brand_id: integer("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    status: text("status").notNull().default("active"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("short_domains_org_id_domain_unique").on(table.org_id, table.domain),
    index("short_domains_org_id_idx").on(table.org_id),
    index("short_domains_brand_id_idx").on(table.brand_id),
    check(
      "short_domains_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
  ],
);

export type ShortDomain = typeof short_domains.$inferSelect;
export type NewShortDomain = typeof short_domains.$inferInsert;

// Deduped destination URLs. Many links point at the same final URL, so the
// full URL is stored once (keyed by a hash of its normalized form) and
// referenced by id from `links`.
export const link_destinations = pgTable(
  "link_destinations",
  {
    id: serial("id").primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    // SHA-256 of the normalized URL — the dedup key.
    url_hash: text("url_hash").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("link_destinations_org_id_url_hash_unique").on(
      table.org_id,
      table.url_hash,
    ),
    index("link_destinations_org_id_idx").on(table.org_id),
  ],
);

export type LinkDestination = typeof link_destinations.$inferSelect;
export type NewLinkDestination = typeof link_destinations.$inferInsert;

// One minted short link. Skinny by design — the high-volume table. `code` is
// the public short-code (globally unique: the redirect resolves by code
// alone, with no org context on the URL). Idempotency is per "message":
// (stage_id, contact_id, send_token) is unique, so a retry of the same send
// reuses the link while each genuinely new message gets a fresh code. The
// campaign/stage tracking IDs are denormalized here and NOT NULL because a
// link is only ever minted once those exist (a missing tracking ID means
// "the stage isn't ready to send yet").
export const links = pgTable(
  "links",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    short_domain_id: integer("short_domain_id")
      .notNull()
      .references(() => short_domains.id, { onDelete: "restrict" }),
    destination_id: integer("destination_id")
      .notNull()
      .references(() => link_destinations.id, { onDelete: "restrict" }),
    campaign_id: integer("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    stage_id: integer("stage_id")
      .notNull()
      .references(() => campaign_stages.id, { onDelete: "cascade" }),
    // Present at mint time (the stage tracking_id requires a creative), but
    // SET NULL on creative deletion so the link — and its click history —
    // survive for attribution.
    creative_id: integer("creative_id").references(() => creatives.id, {
      onDelete: "set null",
    }),
    contact_id: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    // Caller-supplied idempotency token identifying one outbound message.
    send_token: text("send_token").notNull(),
    campaign_tracking_id: text("campaign_tracking_id").notNull(),
    stage_tracking_id: text("stage_tracking_id").notNull(),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Global, not per-org: the public redirect has only the code to go on.
    unique("links_code_unique").on(table.code),
    // "One link per message" — retries reuse, new messages mint fresh.
    unique("links_stage_contact_send_token_unique").on(
      table.stage_id,
      table.contact_id,
      table.send_token,
    ),
    index("links_org_id_idx").on(table.org_id),
    index("links_campaign_id_idx").on(table.campaign_id),
    index("links_stage_id_idx").on(table.stage_id),
    index("links_contact_id_idx").on(table.contact_id),
    index("links_destination_id_idx").on(table.destination_id),
  ],
);

export type Link = typeof links.$inferSelect;
export type NewLink = typeof links.$inferInsert;

// Click log. Defined now but UNWIRED in this phase — no endpoint writes it
// yet (the redirect service is Phase 2). Append-only; bot/prefetch clicks
// are classified, never deleted, and filtered at report time.
export const clicks = pgTable(
  "clicks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    link_id: bigint("link_id", { mode: "number" })
      .notNull()
      .references(() => links.id, { onDelete: "cascade" }),
    clicked_at: timestamp("clicked_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ip: text("ip"),
    user_agent: text("user_agent"),
    referer: text("referer"),
    classification: text("classification").notNull().default("unknown"),
  },
  (table) => [
    index("clicks_link_id_idx").on(table.link_id),
    index("clicks_org_id_idx").on(table.org_id),
    index("clicks_clicked_at_idx").on(table.clicked_at),
    check(
      "clicks_classification_check",
      sql`${table.classification} IN ('human', 'bot', 'prefetch', 'unknown')`,
    ),
  ],
);

export type Click = typeof clicks.$inferSelect;
export type NewClick = typeof clicks.$inferInsert;
