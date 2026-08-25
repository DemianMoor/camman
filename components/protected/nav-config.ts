import {
  Activity,
  BarChart3,
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
  Search,
  Send,
  ShoppingBag,
  Tag,
  type LucideIcon,
  UserCheck,
  UserCog,
  UserMinus,
  Users,
} from "lucide-react";

import { isEntityAvailable } from "@/lib/feature-flags";

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  disabled?: boolean;
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
      { label: "Overview", href: "/reports", icon: BarChart3, exact: true },
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
        icon: Send,
        disabled: !isEntityAvailable("campaigns"),
      },
      // WS4 §B1 — cross-campaign fleet view of today's tracked stages.
      {
        label: "Today's sends",
        href: "/sends/today",
        icon: CalendarClock,
        disabled: !isEntityAvailable("campaigns"),
      },
      {
        label: "Creatives",
        href: "/creatives",
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
    // EPC/revenue funnel) — see docs/04-features/delivery-report.md.
    label: "Reports",
    items: [
      { label: "Overview", href: "/reports", icon: BarChart3, exact: true },
      { label: "By Number", href: "/reports/number", icon: Phone },
      { label: "By Offer", href: "/reports/offer", icon: ShoppingBag },
      { label: "By Sequence", href: "/reports/sequence", icon: Layers },
      { label: "Hourly", href: "/reports/hourly", icon: CalendarClock },
      { label: "By Group", href: "/reports/group", icon: FolderTree },
      { label: "Delivery", href: "/reports/delivery", icon: CheckCheck },
    ],
  },
  {
    label: "Audience",
    items: [
      {
        label: "Contacts",
        href: "/contacts",
        icon: Users,
        disabled: !isEntityAvailable("contacts"),
      },
      {
        label: "Segments",
        href: "/segments",
        icon: Layers,
        disabled: !isEntityAvailable("segments"),
      },
      {
        label: "Contact Groups",
        href: "/contact-groups",
        icon: FolderTree,
        disabled: !isEntityAvailable("contact_groups"),
      },
      {
        label: "Opt-Outs",
        href: "/opt-outs",
        icon: UserMinus,
        disabled: !isEntityAvailable("opt_outs"),
      },
      {
        label: "Opt-Ins",
        href: "/opt-ins",
        icon: UserCheck,
        disabled: !isEntityAvailable("opt_ins"),
      },
      {
        label: "Clickers",
        href: "/clickers",
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
        icon: Tag,
        disabled: !isEntityAvailable("brands"),
      },
      {
        label: "Offers",
        href: "/offers",
        icon: ShoppingBag,
        disabled: !isEntityAvailable("offers"),
      },
      {
        label: "Affiliate Networks",
        href: "/affiliate-networks",
        icon: Network,
        disabled: !isEntityAvailable("networks"),
      },
      {
        label: "SMS Providers",
        href: "/providers",
        icon: Phone,
        disabled: !isEntityAvailable("providers"),
      },
      {
        label: "Routing Types",
        href: "/routing-types",
        icon: Route,
        disabled: !isEntityAvailable("routing_types"),
      },
      {
        label: "Traffic Types",
        href: "/traffic-types",
        icon: Activity,
        disabled: !isEntityAvailable("traffic_types"),
      },
      {
        label: "UTM Tags",
        href: "/utm-tags",
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
        icon: Send,
      },
      // Per-provider sending posture (R4). Distinct from "Sending" above, which
      // is the ORG-wide master switch — this one is per-account.
      {
        label: "Providers",
        href: "/settings/providers",
        icon: Phone,
      },
      // Brand short domains (B1). The only write surface for them — the brand
      // form's single text field was removed, since a brand may hold several.
      {
        label: "Short Domains",
        href: "/settings/short-domains",
        icon: LinkIcon,
      },
      {
        label: "Carrier Lookup",
        href: "/settings/lookup",
        icon: Phone,
      },
      // Partner intake credentials (Drip P2). Leads captured through these keys
      // are stored raw and processed by nothing until Phase 3 — the page says so.
      {
        label: "Partner Keys",
        href: "/settings/partners",
        icon: KeyRound,
      },
      // The drip routing debugger. Lives under Settings because it is an
      // operator tool, not a campaign surface.
      {
        label: "Why Not Routed",
        href: "/drip/why-not-routed",
        icon: Search,
      },
      {
        label: "User Management",
        href: "/settings/users",
        icon: UserCog,
        disabled: true,
      },
    ],
  },
];
