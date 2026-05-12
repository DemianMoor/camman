"use client";

import { useEffect, useState } from "react";
import { Loader2, Undo2 } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/components/protected/auth-context";
import { toastApiError } from "@/lib/api/toast-error";
import { formatCampaignDateTime } from "@/lib/campaign-timezone";
import { useApiCall } from "@/lib/hooks/use-api-call";

type ImportRow = {
  id: number;
  filename: string | null;
  submitted_rows: number;
  processed_rows: number;
  delivered_added: number;
  failed_added: number;
  optouts_added: number;
  clickers_added: number;
  total_cost_added: string;
  mapping_id: number | null;
  imported_by_user_id: string | null;
  reverted_at: string | null;
  reverted_by_user_id: string | null;
  created_at: string;
};

export interface ImportHistoryDialogProps {
  campaignId: number;
  stageId: number;
  stageNumber: number;
  members?: Array<{ user_id: string; display_name: string | null }>;
  onClose: () => void;
  onReverted: () => void; // called after successful revert for refetch
}

export function ImportHistoryDialog({
  campaignId,
  stageId,
  stageNumber,
  members = [],
  onClose,
  onReverted,
}: ImportHistoryDialogProps) {
  const { can } = useAuth();
  const listApi = useApiCall<{ data: ImportRow[] }>();
  const revertApi = useApiCall<unknown>();
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [tick, setTick] = useState(0);
  const [confirming, setConfirming] = useState<ImportRow | null>(null);

  useEffect(() => {
    (async () => {
      const r = await listApi.execute(
        `/api/campaigns/${campaignId}/stages/${stageId}/imports`,
      );
      if (r.ok) setRows(r.data.data);
    })();
  }, [campaignId, stageId, tick, listApi.execute]);

  const canRevert = can("result_imports.revert");

  function memberLabel(uid: string | null): string {
    if (!uid) return "—";
    const m = members.find((x) => x.user_id === uid);
    return m?.display_name ?? uid.slice(0, 8);
  }

  async function doRevert(row: ImportRow) {
    const r = await revertApi.execute(
      `/api/campaigns/${campaignId}/stages/${stageId}/imports/${row.id}/revert`,
      { method: "POST" },
    );
    if (r.ok) {
      toast.success("Import reverted.");
      setConfirming(null);
      setTick((n) => n + 1);
      onReverted();
    } else {
      toastApiError(r);
    }
  }

  return (
    <>
      <div className="grid gap-3">
        <p className="text-sm text-muted-foreground">
          Imports for stage {stageNumber}. Reverting an import removes its
          stage rows, opt-outs and clickers it created (unless another import
          still references them), and rolls back the stage counters.
        </p>
        {listApi.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2
              className="size-5 animate-spin text-muted-foreground"
              aria-hidden
            />
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-md border bg-muted/30 py-6 text-center text-sm text-muted-foreground">
            No imports yet.
          </div>
        ) : (
          <div className="rounded-md border">
            <table className="min-w-full text-sm">
              <thead className="border-b bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">When</th>
                  <th className="px-3 py-2 text-left">User</th>
                  <th className="px-3 py-2 text-left">Filename</th>
                  <th className="px-3 py-2 text-left">Counts</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const reverted = row.reverted_at !== null;
                  return (
                    <tr key={row.id} className="border-b last:border-b-0">
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {formatCampaignDateTime(row.created_at)}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {memberLabel(row.imported_by_user_id)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {row.filename ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {reverted ? (
                          <Badge variant="secondary">
                            Reverted by {memberLabel(row.reverted_by_user_id)}
                          </Badge>
                        ) : (
                          <span className="font-mono text-muted-foreground">
                            ✓{row.delivered_added} ✗{row.failed_added} ⊘
                            {row.optouts_added} ↗{row.clickers_added}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {!reverted && canRevert ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={revertApi.isLoading}
                            onClick={() => setConfirming(row)}
                          >
                            <Undo2 className="size-4" aria-hidden /> Revert
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex justify-end pt-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert this import?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming
                ? `${confirming.processed_rows.toLocaleString()} stage rows will be deleted, and opt-outs / clickers created by this import will be removed unless another import still references them. Stage counters will be rolled back.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revertApi.isLoading}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={revertApi.isLoading}
              onClick={(e) => {
                e.preventDefault();
                if (confirming) void doRevert(confirming);
              }}
            >
              Revert
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
