"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { navGroups, type NavItem } from "./nav-config";

function isActive(pathname: string, href: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}

function NavRow({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  const inner = (
    <>
      <Icon className="size-4 shrink-0" aria-hidden />
      <span className="flex-1 truncate">{item.label}</span>
      {item.disabled ? (
        <Badge variant="outline" className="text-[10px]">
          Soon
        </Badge>
      ) : null}
    </>
  );

  const base =
    "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors";

  if (item.disabled) {
    return (
      <div
        className={cn(
          base,
          "cursor-not-allowed text-muted-foreground/60",
        )}
        aria-disabled
      >
        {inner}
      </div>
    );
  }

  return (
    <Link
      href={item.href}
      className={cn(
        base,
        active
          ? "bg-accent text-accent-foreground"
          : "text-foreground hover:bg-accent/60",
      )}
    >
      {inner}
    </Link>
  );
}

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-4">
      {navGroups.map((group, gi) => (
        <div key={gi} className="flex flex-col gap-1">
          {group.label ? (
            <p className="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.label}
            </p>
          ) : null}
          {group.items.map((item) => (
            <NavRow
              key={item.href}
              item={item}
              active={!item.disabled && isActive(pathname, item.href, item.exact)}
            />
          ))}
        </div>
      ))}
    </nav>
  );
}
