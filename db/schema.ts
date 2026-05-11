import { sql } from "drizzle-orm";
import {
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
