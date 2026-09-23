import {
  Activity,
  BarChart3,
  Bell,
  CalendarClock,
  CheckCheck,
  FolderTree,
  KeyRound,
  Layers,
  LayoutDashboard,
  LinkIcon,
  MessageSquare,
  MousePointer,
  Network,
  Phone,
  Route,
  ScrollText,
  Search,
  Send,
  ShoppingBag,
  Tag,
  Target,
  type LucideIcon,
  UserCheck,
  UserCog,
  UserMinus,
  Users,
} from "lucide-react";

import { isEntityAvailable } from "@/lib/feature-flags";
import type { Permission } from "@/lib/permissions";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  disabled?: boolean;
  // Hide the row entirely unless the signed-in role holds this permission.
  //
  // ⚠️ THIS IS TIDINESS, NOT A CONTROL. A hidden link stops nobody typing the
  // URL, and the nav config ships in the client bundle either way. Every
  // gated route re-checks server-side — /settings/users calls
  // requireOrgMembership + can(role, "users.manage") in the page body, and its
  // API routes check independently. Removing this line must never be the
  // difference between safe and unsafe.
  permission?: Permission;
  // Match the active state exactly (===) instead of the default prefix match.
  // Needed for a parent route that has child routes under the same path, e.g.
  // /reports (Overview) vs /reports/number — otherwise Overview would light up
  // on every sub-route.
  exact?: boolean;
};

export type NavGroup = {
  label: string | null;
  items: NavItem[];
  // Collapsible groups render their label as a toggle button and start
  // collapsed (the group holding the current route auto-expands). Groups with
  // `collapsible: false` — and the unlabelled top group — are always open.
  collapsible?: boolean;
};

// `disabled` for entity items is derived from lib/feature-flags.ts. Flipping a
// flag there automatically enables the nav item. User Management is not an
// entity — it's a built-in feature, so its disabled state is hardcoded.
export const navGroups: NavGroup[] = [
  {
    label: null,
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
      // Deliberate duplicate of the Reports > Overview row. The Reports group
      // is collapsible, so this pins the most-visited report to the top of the
      // sidebar. Both rows highlight on /reports — that is intended.
      { label: "Overview", href: "/reports", icon: BarChart3, exact: true, permission: "campaigns.view" },
    ],
  },
  {
    label: "Campaigns",
    // Always expanded — the primary workflow, never hidden behind a toggle.
    collapsible: false,
    items: [
      {
        label: "Campaigns",
        href: "/campaigns",
        permission: "campaigns.view",
        icon: Send,
        disabled: !isEntityAvailable("campaigns"),
      },
      // WS4 §B1 — cross-campaign fleet view of today's tracked stages.
      {
        label: "Today's sends",
        href: "/sends/today",
        permission: "stages.view",
        icon: CalendarClock,
        disabled: !isEntityAvailable("campaigns"),
      },
      {
        label: "Creatives",
        href: "/creatives",
        permission: "creatives.view",
        icon: MessageSquare,
        disabled: !isEntityAvailable("creatives"),
      },
    ],
  },
  {
    // Reports are a feature (Keitaro funnel + performance rollup), not entities —
    // always enabled. Overview is the Keitaro funnel; then the five rollup
    // dimensions (each a /reports/<dimension> tab route); then Delivery, which
    // has its own route and its own column set (delivery receipts, not the
    // EPC/revenue funnel) — see docs/04-features/delivery-report.md. Last,
    // Audience Stats: offer results per contact group — see
    // docs/04-features/audience-report.md. Not "Audience": that label is the
    // nav group below.
    label: "Reports",
    items: [
      { label: "Overview", href: "/reports", icon: BarChart3, exact: true, permission: "campaigns.view" },
      { label: "By Number", href: "/reports/number", icon: Phone, permission: "campaigns.view" },
      { label: "By Offer", href: "/reports/offer", icon: ShoppingBag, permission: "campaigns.view" },
      { label: "By Sequence", href: "/reports/sequence", icon: Layers, permission: "campaigns.view" },
      { label: "Hourly", href: "/reports/hourly", icon: CalendarClock, permission: "campaigns.view" },
      { label: "By Group", href: "/reports/group", icon: FolderTree, permission: "campaigns.view" },
      { label: "Delivery", href: "/reports/delivery", icon: CheckCheck, permission: "campaigns.view" },
      { label: "Audience Stats", href: "/reports/audience", icon: Target, permission: "campaigns.view" },
    ],
  },
  {
    label: "Audience",
    items: [
      {
        label: "Contacts",
        href: "/contacts",
        permission: "contacts.view",
        icon: Users,
        disabled: !isEntityAvailable("contacts"),
      },
      {
        label: "Segments",
        href: "/segments",
        permission: "segments.view",
        icon: Layers,
        disabled: !isEntityAvailable("segments"),
      },
      {
        label: "Contact Groups",
        href: "/contact-groups",
        permission: "contact_groups.view",
        icon: FolderTree,
        disabled: !isEntityAvailable("contact_groups"),
      },
      {
        label: "Opt-Outs",
        href: "/opt-outs",
        permission: "opt_outs.view",
        icon: UserMinus,
        disabled: !isEntityAvailable("opt_outs"),
      },
      {
        label: "Opt-Ins",
        href: "/opt-ins",
        permission: "opt_ins.view",
        icon: UserCheck,
        disabled: !isEntityAvailable("opt_ins"),
      },
      {
        label: "Clickers",
        href: "/clickers",
        permission: "clickers.view",
        icon: MousePointer,
        disabled: !isEntityAvailable("clickers"),
      },
    ],
  },
  {
    label: "Registry",
    items: [
      {
        label: "Brands",
        href: "/brands",
        permission: "brands.view",
        icon: Tag,
        disabled: !isEntityAvailable("brands"),
      },
      {
        label: "Offers",
        href: "/offers",
        permission: "offers.view",
        icon: ShoppingBag,
        disabled: !isEntityAvailable("offers"),
      },
      {
        label: "Affiliate Networks",
        href: "/affiliate-networks",
        permission: "networks.view",
        icon: Network,
        disabled: !isEntityAvailable("networks"),
      },
      {
        label: "SMS Providers",
        href: "/providers",
        permission: "providers.view",
        icon: Phone,
        disabled: !isEntityAvailable("providers"),
      },
      {
        label: "Routing Types",
        href: "/routing-types",
        permission: "routing_types.view",
        icon: Route,
        disabled: !isEntityAvailable("routing_types"),
      },
      {
        label: "Traffic Types",
        href: "/traffic-types",
        permission: "traffic_types.view",
        icon: Activity,
        disabled: !isEntityAvailable("traffic_types"),
      },
      {
        label: "UTM Tags",
        href: "/utm-tags",
        permission: "utm_tags.view",
        icon: LinkIcon,
        disabled: !isEntityAvailable("utm_tags"),
      },
    ],
  },
  {
    label: "Settings",
    items: [
      {
        label: "Sending",
        href: "/settings/sending",
        permission: "compliance.manage",
        icon: Send,
      },
      // Per-provider sending posture (R4). Distinct from "Sending" above, which
      // is the ORG-wide master switch — this one is per-account.
      {
        label: "Providers",
        href: "/settings/providers",
        permission: "provider_credentials.view",
        icon: Phone,
      },
      // Brand short domains (B1). The only write surface for them — the brand
      // form's single text field was removed, since a brand may hold several.
      {
        label: "Short Domains",
        href: "/settings/short-domains",
        permission: "brands.update",
        icon: LinkIcon,
      },
      {
        label: "Carrier Lookup",
        href: "/settings/lookup",
        permission: "lookup.admin",
        icon: Phone,
      },
      // Partner intake credentials (Drip P2). Leads captured through these keys
      // are stored raw and processed by nothing until Phase 3 — the page says so.
      {
        label: "Partner Keys",
        href: "/settings/partners",
        permission: "partner_keys.view",
        icon: KeyRound,
      },
      // The drip routing debugger. Lives under Settings because it is an
      // operator tool, not a campaign surface.
      {
        label: "Why Not Routed",
        href: "/drip/why-not-routed",
        permission: "campaigns.drain",
        icon: Search,
      },
      {
        label: "Notifications",
        href: "/settings/notifications",
        permission: "campaigns.drain",
        icon: Bell,
      },
      // Contact lifecycle thresholds + the status engine switch (migration 0187).
      // The page itself is gated on the same permission server-side.
      {
        label: "Lifecycle",
        href: "/settings/lifecycle",
        permission: "lifecycle.configure",
        icon: Activity,
      },
      // Owner-only member roster, invites and the deactivation kill switch
      // (869et3vm1 Phase 1). Enforced server-side; `permission` only keeps the
      // link out of the way for roles that would get a 403.
      {
        label: "User Management",
        href: "/settings/users",
        icon: UserCog,
        permission: "users.manage",
      },
      // Owner-only audit feed (869et3vm1 Phase 4).
      {
        label: "Audit Log",
        href: "/settings/audit",
        icon: ScrollText,
        permission: "audit.view",
      },
    ],
  },
];
