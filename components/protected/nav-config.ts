import {
  Activity,
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

export type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  disabled?: boolean;
};

export type NavGroup = {
  label: string | null;
  items: NavItem[];
};

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
      { label: "Campaigns", href: "/campaigns", icon: Send, disabled: true },
      { label: "Creatives", href: "/creatives", icon: MessageSquare, disabled: true },
    ],
  },
  {
    label: "Audience",
    items: [
      { label: "Contacts", href: "/contacts", icon: Users, disabled: true },
      { label: "Segments", href: "/segments", icon: Layers, disabled: true },
      { label: "Segment Groups", href: "/segment-groups", icon: FolderTree, disabled: true },
      { label: "Opt-Outs", href: "/opt-outs", icon: UserMinus, disabled: true },
      { label: "Opt-Ins", href: "/opt-ins", icon: UserCheck, disabled: true },
      { label: "Clickers", href: "/clickers", icon: MousePointer, disabled: true },
    ],
  },
  {
    label: "Registry",
    items: [
      { label: "Brands", href: "/brands", icon: Tag },
      { label: "Offers", href: "/offers", icon: ShoppingBag, disabled: true },
      { label: "Affiliate Networks", href: "/affiliate-networks", icon: Network, disabled: true },
      { label: "SMS Providers", href: "/providers", icon: Phone, disabled: true },
      { label: "Routing Types", href: "/routing-types", icon: Route, disabled: true },
      { label: "Traffic Types", href: "/traffic-types", icon: Activity, disabled: true },
      { label: "UTM Tags", href: "/utm-tags", icon: LinkIcon, disabled: true },
    ],
  },
  {
    label: "Settings",
    items: [
      { label: "User Management", href: "/settings/users", icon: UserCog, disabled: true },
    ],
  },
];
