"use client";

import { useState } from "react";
import { Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toastApiError } from "@/lib/api/toast-error";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";

// "Why wasn't this number routed?" (Drip Phase 4).
//
// The whole value of this screen is that it reports what the ROUTER actually
// decides, not a second opinion: the endpoint calls the same evaluator the
// worker calls. It also distinguishes the stages a number can get stuck at,
// because "nothing happened" has very different causes and very different fixes:
//   never_seen             -> the partner isn't posting it, or the key is sandbox
//   stuck_before_contact   -> intake got it but enrichment dropped it (landline?)
//   contact_without_event  -> it exists, but not from partner intake
//   evaluated              -> routing considered it; here is every rule's verdict

type RuleVerdict = "pass" | "mismatch" | "missing" | "blocked";

type Candidate = {
  campaign_id: number;
  campaign_name: string | null;
  priority: number;
  eligible: boolean;
  rules: Record<string, RuleVerdict>;
  detail: Record<string, string>;
};

type Result = {
  phone: string;
  found: boolean;
  stage: string;
  explanation?: string;
  contact?: Record<string, unknown>;
  inbox?: Record<string, unknown>[];
  events?: Record<string, unknown>[];
  live_evaluation?: {
    global: Record<string, RuleVerdict>;
    globalDetail: Record<string, string>;
    candidates: Candidate[];
    winner: Candidate | null;
  } | null;
};

const VERDICT_STYLE: Record<RuleVerdict, string> = {
  pass: "text-emerald-600",
  mismatch: "text-amber-600",
  // Deliberately distinct from mismatch: the fix is the partner sending the
  // field, not the targeting.
  missing: "text-sky-600",
  blocked: "text-destructive",
};

export function WhyNotRouted() {
  const api = useApiCall<Result>();
  const [phone, setPhone] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  const lookup = async () => {
    const r = await api.execute(`/api/drip/why-not-routed?phone=${encodeURIComponent(phone.trim())}`);
    if (!r.ok) {
      setResult(null);
      return toastApiError(r);
    }
    setResult(r.data);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div className="flex-1 max-w-md">
          <Label htmlFor="wnr-phone">Phone number</Label>
          <Input
            id="wnr-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void lookup()}
            placeholder="+1 202 555 0199"
            className="font-mono"
          />
        </div>
        <Button type="button" onClick={() => void lookup()} disabled={!phone.trim() || api.isLoading}>
          <Search className="mr-1 size-4" /> Explain
        </Button>
      </div>

      {result && (
        <Card>
          <CardContent className="space-y-4 pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm">{result.phone}</span>
              <Badge variant={result.stage === "evaluated" ? "secondary" : "outline"}>
                {result.stage.replace(/_/g, " ")}
              </Badge>
            </div>

            {result.explanation && <p className="text-sm">{result.explanation}</p>}

            {result.inbox && result.inbox.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium">Inbox rows</p>
                <pre className="overflow-x-auto rounded bg-muted p-2 text-[11px]">
                  {JSON.stringify(result.inbox, null, 2)}
                </pre>
              </div>
            )}

            {result.live_evaluation && (
              <>
                <div>
                  <p className="mb-1 text-sm font-medium">Applies to every campaign</p>
                  <ul className="text-sm">
                    {Object.entries(result.live_evaluation.global).map(([rule, v]) => (
                      <li key={rule} className="flex gap-2">
                        <span className={VERDICT_STYLE[v]}>{v}</span>
                        <span className="text-muted-foreground">{rule.replace(/_/g, " ")}</span>
                        {result.live_evaluation!.globalDetail[rule] && (
                          <span className="text-muted-foreground text-xs">
                            — {result.live_evaluation!.globalDetail[rule]}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <p className="mb-1 text-sm font-medium">
                    Per campaign{" "}
                    {result.live_evaluation.winner ? (
                      <Badge variant="secondary">
                        would route to #{result.live_evaluation.winner.campaign_id}
                      </Badge>
                    ) : (
                      <Badge variant="outline">no campaign would take it</Badge>
                    )}
                  </p>
                  {result.live_evaluation.candidates.length === 0 ? (
                    <p className="text-muted-foreground text-sm">
                      There are no active drip campaigns at all.
                    </p>
                  ) : (
                    <ul className="divide-y rounded-md border">
                      {result.live_evaluation.candidates.map((c) => (
                        <li key={c.campaign_id} className="space-y-1 px-3 py-2 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">
                              {c.campaign_name ?? `#${c.campaign_id}`}
                            </span>
                            <span className="text-muted-foreground text-xs">
                              priority {c.priority}
                            </span>
                            <Badge variant={c.eligible ? "secondary" : "outline"}>
                              {c.eligible ? "eligible" : "not eligible"}
                            </Badge>
                          </div>
                          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                            {Object.entries(c.rules)
                              .filter(([, v]) => v !== "pass")
                              .map(([rule, v]) => (
                                <span key={rule} className={VERDICT_STYLE[v]}>
                                  {rule.replace(/_/g, " ")}: {v}
                                  {c.detail[rule] ? ` (${c.detail[rule]})` : ""}
                                </span>
                              ))}
                            {Object.values(c.rules).every((v) => v === "pass") && (
                              <span className={VERDICT_STYLE.pass}>every rule passed</span>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}

            {result.events && result.events.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium">Arrivals</p>
                <ul className="text-muted-foreground space-y-0.5 text-xs">
                  {result.events.map((e) => (
                    <li key={String(e.id)}>
                      {formatCampaignDateTime(String(e.received_at))} · tag{" "}
                      {String(e.interest_tag ?? "—")} · partner {String(e.partner_slug)}
                      {e.journey_state ? ` · journey ${String(e.journey_state)}` : " · no journey"}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
