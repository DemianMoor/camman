import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
