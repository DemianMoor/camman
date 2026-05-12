"use client";

import { useState } from "react";
import { Download } from "lucide-react";

import { useAuth } from "@/components/protected/auth-context";
import { Button } from "@/components/ui/button";
import type { Permission } from "@/lib/permissions";

export interface ExportButtonProps {
  endpoint: string;
  queryParams?: Record<string, string | number | boolean | null | undefined>;
  filenamePrefix?: string;
  permission?: Permission;
  label?: string;
  // If false (default), button is hidden when there's nothing to export.
  // Pass a count from the page if you want this behavior wired up.
  disabledIfEmpty?: number;
}

// Drop-in CSV export trigger. Entity-agnostic: caller passes the endpoint,
// the current filter state, and (optionally) a permission to gate visibility.
// The download goes through the browser's native mechanism — we set href +
// download on a transient anchor and click it — so the server can stream
// arbitrarily large responses without us buffering in JS.
export function ExportButton({
  endpoint,
  queryParams,
  filenamePrefix = "export",
  permission,
  label = "Export CSV",
  disabledIfEmpty,
}: ExportButtonProps) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);

  if (permission && !can(permission)) return null;

  const empty =
    typeof disabledIfEmpty === "number" && disabledIfEmpty === 0;

  function handleClick() {
    if (busy || empty) return;
    setBusy(true);

    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(queryParams ?? {})) {
      if (v === null || v === undefined) continue;
      sp.set(k, String(v));
    }
    const qs = sp.toString();
    const url = qs ? `${endpoint}?${qs}` : endpoint;

    // Mirror the server-side filename shape from lib/csv/stream-export.ts so
    // browsers that honor the anchor's `download` attribute over the response's
    // Content-Disposition still produce a unique-per-second filename.
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const min = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    const filename = `${filenamePrefix}-${yyyy}-${mm}-${dd}-${hh}${min}${ss}.csv`;

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();

    // Brief double-click guard — re-enables after the browser has handled
    // the click. No need to track real download completion.
    setTimeout(() => setBusy(false), 200);
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={busy || empty}
      title={empty ? "Nothing to export with the current filters" : undefined}
    >
      <Download className="size-4" aria-hidden />
      {label}
    </Button>
  );
}
