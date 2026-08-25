"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { usePersistedFilters } from "@/lib/hooks/use-persisted-filters";
import { cn } from "@/lib/utils";
import { navGroups, type NavGroup, type NavItem } from "./nav-config";

const STORAGE_KEY = "sidebar:groups";

// Every collapsible group starts closed. The group holding the current route
// is opened by the effect below, so the user always sees where they are.
const COLLAPSED_DEFAULTS: Record<string, boolean> = Object.fromEntries(
  navGroups
    .filter(isCollapsible)
    .map((group) => [group.label as string, false]),
);

function isCollapsible(group: NavGroup): boolean {
  return group.label !== null && group.collapsible !== false;
}

function isActive(pathname: string, href: string, exact?: boolean) {
  if (exact) return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}

function groupIsActive(pathname: string, group: NavGroup) {
  return group.items.some(
    (item) => !item.disabled && isActive(pathname, item.href, item.exact),
  );
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

const GROUP_LABEL_CLASS =
  "px-2.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground";

export function SidebarNav() {
  const pathname = usePathname();
  const [open, setOpen] = usePersistedFilters<Record<string, boolean>>(
    STORAGE_KEY,
    COLLAPSED_DEFAULTS,
  );

  // Navigating into a collapsed group expands it (and on first mount, so the
  // current page is never hidden). Gated on the pathname actually CHANGING —
  // re-running this on every render would immediately undo a click on the
  // active group's header, making its toggle look dead.
  const lastPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastPathRef.current === pathname) return;
    lastPathRef.current = pathname;
    const active = navGroups.find(
      (group) => isCollapsible(group) && groupIsActive(pathname, group),
    );
    if (active) setOpen({ [active.label as string]: true });
  }, [pathname, setOpen]);

  return (
    <nav className="flex flex-col gap-4">
      {navGroups.map((group, gi) => {
        const collapsible = isCollapsible(group);
        const label = group.label as string;
        const expanded = !collapsible || open[label] === true;
        const panelId = `sidebar-group-${gi}`;

        return (
          <div key={gi} className="flex flex-col gap-1">
            {collapsible ? (
              <button
                type="button"
                onClick={() => setOpen({ [label]: !expanded })}
                aria-expanded={expanded}
                aria-controls={panelId}
                className={cn(
                  GROUP_LABEL_CLASS,
                  "flex items-center gap-1.5 rounded-md py-1.5 text-left transition-colors hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <ChevronRight
                  className={cn(
                    "size-3 shrink-0 transition-transform",
                    expanded && "rotate-90",
                  )}
                  aria-hidden
                />
                <span className="flex-1 truncate">{group.label}</span>
              </button>
            ) : group.label ? (
              // Padded to line up with the collapsible headers, whose label is
              // pushed right by the chevron (size-3 + gap-1.5).
              <p className={cn(GROUP_LABEL_CLASS, "pb-1 ps-[1.125rem]")}>
                {group.label}
              </p>
            ) : null}
            {expanded ? (
              <div id={panelId} className="flex flex-col gap-1">
                {group.items.map((item) => (
                  <NavRow
                    key={item.href}
                    item={item}
                    active={
                      !item.disabled && isActive(pathname, item.href, item.exact)
                    }
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
