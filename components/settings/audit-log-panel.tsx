"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";

type Row = {
  id: string;
  created_at: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  summary: string;
  entity_type: string | null;
  entity_id: string | null;
  ip: string | null;
  metadata: Record<string, unknown> | null;
};

type Response = {
  data: Row[];
  totalCount: number;
  page: number;
  pageSize: number;
  actions: string[];
  actors: { id: string; email: string }[];
};

const ANY = "__any__";
const PAGE_SIZE = 50;

// Colour by family, not by individual action: the useful glance is
// "was anything blocked / was anyone let in", and a per-action palette would be
// noise at a dozen action types and unreadable at thirty.
function tone(action: string): "destructive" | "outline" | "secondary" {
  if (action.startsWith("guardrail.cap") || action.startsWith("guardrail.url")) {
    return "destructive";
  }
  if (action.startsWith("auth.login_denied") || action.startsWith("user.deactivated")) {
    return "destructive";
  }
  if (action.startsWith("guardrail.")) return "secondary";
  return "outline";
}

export function AuditLogPanel() {
  const [data, setData] = useState<Response | null>(null);
  const [page, setPage] = useState(0);
  const [actor, setActor] = useState(ANY);
  const [action, setAction] = useState(ANY);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { execute, isLoading } = useApiCall<Response>();

  const query = useMemo(() => {
    const qs = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    if (actor !== ANY) qs.set("actor", actor);
    if (action !== ANY) qs.set("action", action);
    if (from) qs.set("from", new Date(from).toISOString());
    // `to` is a date input (midnight); push it to the end of that day so the
    // filter reads inclusively, which is how anyone picking a date means it.
    if (to) qs.set("to", new Date(new Date(to).getTime() + 86_399_000).toISOString());
    return qs.toString();
  }, [page, actor, action, from, to]);

  // The codebase's accepted fetch-in-effect shape (see
  // components/settings/provider-connections.tsx): the setState happens inside
  // an async IIFE guarded by `active`, not synchronously in the effect body,
  // which is what react-hooks/set-state-in-effect flags.
  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await execute(`/api/audit-log?${query}`);
      if (active && r.ok) setData(r.data);
    })();
    return () => {
      active = false;
    };
  }, [query, execute]);

  const rows = data?.data ?? [];
  const total = data?.totalCount ?? 0;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 py-4">
          <div className="grid gap-1.5">
            <Label htmlFor="audit-actor">Actor</Label>
            <Select
              value={actor}
              onValueChange={(v) => {
                setActor(v);
                setPage(0);
              }}
            >
              <SelectTrigger id="audit-actor" className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Anyone</SelectItem>
                {(data?.actors ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="audit-action">Action</Label>
            <Select
              value={action}
              onValueChange={(v) => {
                setAction(v);
                setPage(0);
              }}
            >
              <SelectTrigger id="audit-action" className="w-[240px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>All actions</SelectItem>
                {/* Prefix entries: an owner thinks in families first. */}
                <SelectItem value="auth.">auth.* (sign-in)</SelectItem>
                <SelectItem value="user.">user.* (accounts)</SelectItem>
                <SelectItem value="guardrail.">guardrail.* (all)</SelectItem>
                {(data?.actions ?? []).map((a) => (
                  <SelectItem key={a} value={a}>
                    {a}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="audit-from">From</Label>
            <Input
              id="audit-from"
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPage(0);
              }}
              className="w-[160px]"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="audit-to">To</Label>
            <Input
              id="audit-to"
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPage(0);
              }}
              className="w-[160px]"
            />
          </div>

          {actor !== ANY || action !== ANY || from || to ? (
            <Button
              variant="ghost"
              onClick={() => {
                setActor(ANY);
                setAction(ANY);
                setFrom("");
                setTo("");
                setPage(0);
              }}
            >
              Clear
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {isLoading && !data ? (
            <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Loading…
            </div>
          ) : rows.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">
              No events match these filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b bg-muted/40 text-left">
                  <tr>
                    <th className="px-4 py-2 font-medium">When</th>
                    <th className="px-4 py-2 font-medium">Actor</th>
                    <th className="px-4 py-2 font-medium">Action</th>
                    <th className="px-4 py-2 font-medium">What happened</th>
                    <th className="px-4 py-2 font-medium">IP</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b align-top last:border-0">
                      <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                        {formatCampaignDateTime(r.created_at)}
                      </td>
                      <td className="px-4 py-2">
                        {r.actor_email ?? (
                          <span className="text-muted-foreground">system</span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <Badge variant={tone(r.action)} className="font-mono text-[11px]">
                          {r.action}
                        </Badge>
                      </td>
                      <td className="px-4 py-2">{r.summary}</td>
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                        {r.ip ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {total.toLocaleString()} event{total === 1 ? "" : "s"}
          {total > 0
            ? ` · showing ${(page * PAGE_SIZE + 1).toLocaleString()}–${Math.min((page + 1) * PAGE_SIZE, total).toLocaleString()}`
            : ""}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page === 0 || isLoading}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= lastPage || isLoading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
