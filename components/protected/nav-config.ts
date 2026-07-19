import {
  Activity,
  BarChart3,
  CalendarClock,
  FolderTree,
  Layers,
  LayoutDashboard,
  LinkIcon,
  MessageSquare,
  MousePointer,
  Network,
  Phone,
  Route,
  Send,
  ShoppingBag,
  Tag,
  UserCheck,
  UserCog,
  UserMinus,
  Users,
  type LucideIcon,
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
};

// `disabled` for entity items is derived from lib/feature-flags.ts. Flipping a
// flag there automatically enables the nav item. User Management is not an
// entity — it's a built-in feature, so its disabled state is hardcoded.
export const navGroups: NavGroup[] = [
  {
    label: null,
    items: [
      { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    ],
  },
  {
    label: "Campaigns",
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
    // always enabled. Overview is the Keitaro funnel; the rest are the five
    // rollup dimensions (each a /reports/<dimension> tab route).
    label: "Reports",
    items: [
      { label: "Overview", href: "/reports", icon: BarChart3, exact: true },
      { label: "By Number", href: "/reports/number", icon: Phone },
      { label: "By Offer", href: "/reports/offer", icon: ShoppingBag },
      { label: "By Sequence", href: "/reports/sequence", icon: Layers },
      { label: "Hourly", href: "/reports/hourly", icon: CalendarClock },
      { label: "By Group", href: "/reports/group", icon: FolderTree },
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
      {
        label: "Carrier Lookup",
        href: "/settings/lookup",
        icon: Phone,
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
