import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  pgTable,
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
    network_id: integer("network_id").references(() => affiliate_networks.id, {
      onDelete: "set null",
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

export const segment_groups = pgTable(
  "segment_groups",
  {
    id: serial("id").primaryKey(),
    segment_group_id: text("segment_group_id").notNull().unique(),
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
      "segment_groups_status_check",
      sql`${table.status} IN ('active', 'archived')`,
    ),
  ],
);

export type SegmentGroup = typeof segment_groups.$inferSelect;
export type NewSegmentGroup = typeof segment_groups.$inferInsert;

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
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("opt_outs_org_id_idx").on(table.org_id),
    index("opt_outs_contact_id_idx").on(table.contact_id),
    index("opt_outs_phone_number_idx").on(table.phone_number),
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

export const segment_segment_groups = pgTable(
  "segment_segment_groups",
  {
    segment_id: integer("segment_id")
      .notNull()
      .references(() => segments.id, { onDelete: "cascade" }),
    segment_group_id: integer("segment_group_id")
      .notNull()
      .references(() => segment_groups.id, { onDelete: "cascade" }),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("segment_segment_groups_pkey").on(
      table.segment_id,
      table.segment_group_id,
    ),
    index("segment_segment_groups_group_id_idx").on(table.segment_group_id),
    index("segment_segment_groups_org_id_idx").on(table.org_id),
  ],
);

export type SegmentSegmentGroup = typeof segment_segment_groups.$inferSelect;
export type NewSegmentSegmentGroup = typeof segment_segment_groups.$inferInsert;

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
    updated_at: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("segment_stats_org_id_idx").on(table.org_id)],
);

export type SegmentStats = typeof segment_stats.$inferSelect;
export type NewSegmentStats = typeof segment_stats.$inferInsert;

// Creatives: SMS copy linked to an Offer, optionally scoped to a Provider
// + Brand. `slug` is auto-generated and used in short-link construction.
// `creative_id` is an optional human-friendly identifier for external
// tracking systems.
export const creatives = pgTable(
  "creatives",
  {
    id: serial("id").primaryKey(),
    creative_id: text("creative_id").unique(),
    slug: text("slug").notNull().unique(),
    org_id: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    offer_id: integer("offer_id")
      .notNull()
      .references(() => offers.id, { onDelete: "cascade" }),
    sms_provider_id: integer("sms_provider_id").references(
      () => sms_providers.id,
      { onDelete: "set null" },
    ),
    brand_id: integer("brand_id").references(() => brands.id, {
      onDelete: "set null",
    }),
    text: text("text").notNull(),
    status: text("status").notNull().default("draft"),
    archived_at: timestamp("archived_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("creatives_org_id_idx").on(table.org_id),
    index("creatives_offer_id_idx").on(table.offer_id),
    index("creatives_sms_provider_id_idx").on(table.sms_provider_id),
    index("creatives_brand_id_idx").on(table.brand_id),
    index("creatives_status_idx").on(table.status),
    check(
      "creatives_status_check",
      sql`${table.status} IN ('draft', 'pending', 'ready', 'paused', 'archived')`,
    ),
  ],
);

export type Creative = typeof creatives.$inferSelect;
export type NewCreative = typeof creatives.$inferInsert;

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
    start_date: date("start_date"),
    end_date: date("end_date"),
    status: text("status").notNull().default("draft"),
    previous_status: text("previous_status"),
    status_changed_at: timestamp("status_changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
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
    click_count: integer("click_count").notNull().default(0),
    notes: text("notes"),
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
  ],
);

export type CampaignStage = typeof campaign_stages.$inferSelect;
export type NewCampaignStage = typeof campaign_stages.$inferInsert;

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
    total_cost_added: numeric("total_cost_added", { precision: 12, scale: 4 })
      .notNull()
      .default("0"),
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
      sql`${table.outcome} IN ('delivered', 'failed', 'optout', 'clicker', 'noop')`,
    ),
  ],
);

export type StageResultRow = typeof stage_result_rows.$inferSelect;
export type NewStageResultRow = typeof stage_result_rows.$inferInsert;
