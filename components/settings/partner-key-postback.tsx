"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { toastApiError } from "@/lib/api/toast-error";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { postbackConfigError, SYSTEM_PLACEHOLDERS } from "@/lib/partners/postbacks/template";
import type { PartnerKeyJson } from "@/lib/partners/queries";

// The "Sales postback" section of a partner key card (partner_keys.postback_*),
// plus the delivery log. Saves through the key PATCH route; the parent reloads
// the list afterwards. Only template.ts is imported from lib/partners/postbacks —
// the rest of that folder is server-only.

type LogRow = {
  id: number;
  created_at: string;
  is_test: boolean;
  conversion_event_id: number | null;
  status: string;
  attempts: number;
  last_response_code: number | null;
  last_error: string | null;
  last_url_masked: string | null;
  last_attempt_at: string | null;
  delivered_at: string | null;
};

type TestResult = {
  ok: boolean;
  status_code: number | null;
  url_masked: string | null;
  error: string | null;
};

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  delivered: "default",
  pending: "secondary",
  failed: "destructive",
  cancelled: "outline",
};

export function PartnerKeyPostback({
  row,
  canManage,
  onChanged,
}: {
  row: PartnerKeyJson;
  canManage: boolean;
  onChanged: () => void;
}) {
  const saveApi = useApiCall<unknown>();
  const testApi = useApiCall<TestResult>();
  const logApi = useApiCall<{ data: LogRow[] }>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [enabled, setEnabled] = useState(row.postback_enabled);
  const [template, setTemplate] = useState(row.postback_url_template ?? "");
  const [includePayout, setIncludePayout] = useState(row.postback_include_payout);
  const [firstOnly, setFirstOnly] = useState(row.postback_first_purchase_only);
  // The server's own validation message from the last failed save (client and server checks can drift).
  const [serverError, setServerError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [failedOnly, setFailedOnly] = useState(false);
  const [logRows, setLogRows] = useState<LogRow[] | null>(null);

  const trimmed = template.trim();
  const dirty =
    enabled !== row.postback_enabled ||
    trimmed !== (row.postback_url_template ?? "") ||
    includePayout !== row.postback_include_payout ||
    firstOnly !== row.postback_first_purchase_only;

  // Mirrors the server check; an empty template is only an error once enabling.
  const templateError =
    trimmed === ""
      ? enabled
        ? "A postback URL template is required to enable postbacks"
        : null
      : postbackConfigError({ template: trimmed, passthroughFields: row.passthrough_fields, includePayout });

  const chips = [
    ...SYSTEM_PLACEHOLDERS.filter((p) => p !== "payout" || includePayout),
    ...row.passthrough_fields,
  ];

  const insertChip = (name: string) => {
    const el = textareaRef.current;
    const token = `{${name}}`;
    const start = el?.selectionStart ?? template.length;
    const end = el?.selectionEnd ?? template.length;
    setTemplate(template.slice(0, start) + token + template.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const save = async () => {
    const r = await saveApi.execute(`/api/partner-keys/${row.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        postback_enabled: enabled,
        postback_url_template: trimmed === "" ? null : trimmed,
        postback_include_payout: includePayout,
        postback_first_purchase_only: firstOnly,
      }),
    });
    if (!r.ok) {
      setServerError(r.status === 400 ? r.error : null);
      return toastApiError(r);
    }
    setServerError(null);
    toast.success("Postback settings saved");
    onChanged();
  };

  // The log GET needs partner_keys.manage, so without it the section is hidden.
  const loadLog = logApi.execute;
  const [logTick, setLogTick] = useState(0);
  const reloadLog = () => setLogTick((n) => n + 1);

  useEffect(() => {
    if (!canManage) return;
    let live = true;
    void loadLog(`/api/partner-keys/${row.id}/postbacks${failedOnly ? "?failed=1" : ""}`).then((r) => {
      if (!live) return;
      if (r.ok) setLogRows(r.data.data);
      else toastApiError(r);
    });
    return () => {
      live = false;
    };
  }, [canManage, loadLog, row.id, failedOnly, logTick]);

  const sendTest = async () => {
    setTestResult(null);
    setTestError(null);
    const r = await testApi.execute(`/api/partner-keys/${row.id}/postback-test`, { method: "POST" });
    if (r.ok) setTestResult(r.data);
    else setTestError(r.error);
    reloadLog();
  };

  const canSendTest = !dirty && !!row.postback_url_template;

  return (
    <div className="space-y-3 border-t pt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">Sales postback</span>
        {canManage && (
          <div className="flex items-center gap-2">
            <Label htmlFor={`postback-enabled-${row.id}`} className="text-xs">
              Enabled
            </Label>
            <Switch
              id={`postback-enabled-${row.id}`}
              checked={enabled}
              disabled={saveApi.isLoading}
              onCheckedChange={setEnabled}
            />
          </div>
        )}
        {!canManage && <Badge variant="outline">{row.postback_enabled ? "enabled" : "off"}</Badge>}
      </div>

      <p className="text-muted-foreground text-xs">
        Fires on: <span className="text-foreground font-medium">Purchase (approved)</span>
        {row.postback_active_since && (
          <> · sales recorded since {formatCampaignDateTime(row.postback_active_since)} (earlier sales are never sent)</>
        )}
      </p>

      <fieldset className="space-y-1" disabled={!canManage || saveApi.isLoading}>
        <legend className="text-xs font-medium">Count</legend>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="radio"
            name={`postback-count-${row.id}`}
            checked={!firstOnly}
            onChange={() => setFirstOnly(false)}
          />
          Every purchase
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="radio"
            name={`postback-count-${row.id}`}
            checked={firstOnly}
            onChange={() => setFirstOnly(true)}
          />
          First purchase per journey only
        </label>
      </fieldset>

      <div className="space-y-1">
        <Label htmlFor={`postback-template-${row.id}`} className="text-xs">
          Postback URL template
        </Label>
        <Textarea
          id={`postback-template-${row.id}`}
          ref={textareaRef}
          rows={3}
          className="font-mono text-xs"
          placeholder="https://partner.example/pb?rid={relay_lead_id}&c={conversion_id}&s={status}"
          value={template}
          onChange={(e) => {
            setTemplate(e.target.value);
            setServerError(null);
          }}
          disabled={!canManage || saveApi.isLoading}
        />
        {canManage && (
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button
                key={c}
                type="button"
                className="bg-secondary text-secondary-foreground hover:bg-secondary/70 rounded-md px-2 py-0.5 font-mono text-xs"
                onClick={() => insertChip(c)}
              >
                {`{${c}}`}
              </button>
            ))}
          </div>
        )}
        {(templateError ?? serverError) && <p className="text-destructive text-xs">{templateError ?? serverError}</p>}
      </div>

      <div className="flex items-start gap-2">
        <Switch
          id={`postback-payout-${row.id}`}
          checked={includePayout}
          disabled={!canManage || saveApi.isLoading}
          onCheckedChange={setIncludePayout}
        />
        <div>
          <Label htmlFor={`postback-payout-${row.id}`} className="text-xs">
            Include payout
          </Label>
          <p className="text-muted-foreground text-xs">
            Sends our revenue for the sale — same sensitivity as the report revenue toggle.
          </p>
        </div>
      </div>

      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saveApi.isLoading || !dirty || templateError !== null}
            onClick={() => void save()}
          >
            Save postback
          </Button>
          {dirty && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setEnabled(row.postback_enabled);
                setTemplate(row.postback_url_template ?? "");
                setIncludePayout(row.postback_include_payout);
                setFirstOnly(row.postback_first_purchase_only);
              }}
            >
              Reset
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={testApi.isLoading || !canSendTest}
            title={canSendTest ? undefined : "Save a template first"}
            onClick={() => void sendTest()}
          >
            Send test
          </Button>
        </div>
      )}

      {testResult && (
        <p className={`text-xs ${testResult.ok ? "text-foreground" : "text-destructive"}`} role="status">
          Test {testResult.ok ? "delivered" : "failed"}
          {testResult.status_code !== null && <> — HTTP {testResult.status_code}</>}
          {testResult.error && <> — {testResult.error}</>}
          {testResult.url_masked && (
            <>
              {" "}
              — <code className="break-all">{testResult.url_masked}</code>
            </>
          )}
        </p>
      )}
      {testError && (
        <p className="text-destructive text-xs" role="status">
          Test not sent — {testError}
        </p>
      )}

      {canManage && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Postback log</span>
            <div className="flex items-center gap-2">
              <Label htmlFor={`postback-failed-${row.id}`} className="text-xs">
                Failed only
              </Label>
              <Switch id={`postback-failed-${row.id}`} checked={failedOnly} onCheckedChange={setFailedOnly} />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="Refresh log"
                disabled={logApi.isLoading}
                onClick={reloadLog}
              >
                <RefreshCw className="size-4" />
              </Button>
            </div>
          </div>
          {logRows && logRows.length === 0 && (
            <p className="text-muted-foreground text-xs">
              {failedOnly ? "No failed postbacks." : "No postbacks yet."}
            </p>
          )}
          {logRows && logRows.length > 0 && (
            <div className="max-h-72 overflow-auto rounded-md border">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted text-muted-foreground sticky top-0">
                  <tr>
                    <th className="px-2 py-1 font-medium">Time</th>
                    <th className="px-2 py-1 font-medium">Type</th>
                    <th className="px-2 py-1 font-medium">Conversion</th>
                    <th className="px-2 py-1 font-medium">URL</th>
                    <th className="px-2 py-1 font-medium">Code</th>
                    <th className="px-2 py-1 font-medium">Attempts</th>
                    <th className="px-2 py-1 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {logRows.map((l) => (
                    <tr key={l.id} className="border-t align-top">
                      <td className="px-2 py-1 whitespace-nowrap">{formatCampaignDateTime(l.created_at)}</td>
                      <td className="px-2 py-1">{l.is_test ? "test" : "live"}</td>
                      <td className="px-2 py-1">{l.conversion_event_id ?? "—"}</td>
                      <td className="max-w-80 min-w-56 px-2 py-1 font-mono break-all">{l.last_url_masked ?? "—"}</td>
                      <td className="px-2 py-1" title={l.last_error ?? undefined}>
                        {l.last_response_code ?? "—"}
                      </td>
                      <td className="px-2 py-1">{l.attempts}</td>
                      <td className="px-2 py-1">
                        <Badge variant={STATUS_VARIANT[l.status] ?? "outline"}>{l.status}</Badge>
                        {l.last_error && l.status !== "delivered" && (
                          <span className="text-destructive ml-1">{l.last_error}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
