"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";
import {
  DIMENSION_TAB_LABEL,
  REPORT_DIMENSIONS,
} from "@/lib/reporting/report-dimensions";

// Tab bar for the /reports section. Overview (/reports) is the Keitaro funnel;
// the five dimension tabs deep-link to /reports/<dimension>. Active state is
// derived from the pathname so it stays correct on refresh and matches the
// sidebar's Reports group.
const TABS: { href: string; label: string; exact: boolean }[] = [
  { href: "/reports", label: "Overview", exact: true },
  ...REPORT_DIMENSIONS.map((d) => ({
    href: `/reports/${d}`,
    label: DIMENSION_TAB_LABEL[d],
    exact: false,
  })),
];

export function ReportsTabs() {
  const pathname = usePathname();
  return (
    <div className="flex flex-wrap gap-1 border-b">
      {TABS.map((t) => {
        const active = t.exact
          ? pathname === t.href
          : pathname === t.href || pathname.startsWith(t.href + "/");
        return (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm transition-colors",
              active
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
