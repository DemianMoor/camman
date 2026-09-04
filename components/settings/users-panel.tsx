"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Link2, Loader2, ShieldOff, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { useAuth } from "@/components/protected/auth-context";
import { linkGoogleIdentityAction } from "@/app/(protected)/actions";
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
import { Card, CardContent } from "@/components/ui/card";
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormDialog } from "@/components/ui/form-dialog";
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
import { toastApiError } from "@/lib/api/toast-error";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { ASSIGNABLE_ROLES } from "@/lib/validators/user-roles";
import { UserApiPanel } from "@/components/settings/user-api-panel";

type MemberRow = {
  id: string;
  user_id: string;
  email: string | null;
  role: string;
  is_active: boolean;
  /** Per-user API on/off switch (869evpmbz). Independent of is_active. */
  api_enabled: boolean;
  /** Un-revoked, un-expired tokens this member holds. */
  live_tokens: number;
  last_login_at: string | null;
  last_login_ip: string | null;
  joined_at: string;
  /** Whether this account can already sign in with Google. */
  has_google: boolean;
  /** Approved-but-unsent stages this member created — the kill switch's blast radius. */
  pending_stages: number;
};

type InviteRow = {
  id: string;
  email: string;
  role: string;
  expires_at: string;
  created_at: string;
  expired: boolean;
};

type ListResponse = { members: MemberRow[]; invites: InviteRow[] };

export function UsersPanel() {
  const { auth } = useAuth();
  const [data, setData] = useState<ListResponse | null>(null);
  const [tick, setTick] = useState(0);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<string>("viewer");
  const [confirmTarget, setConfirmTarget] = useState<MemberRow | null>(null);
  const [apiTarget, setApiTarget] = useState<MemberRow | null>(null);
  const [linking, setLinking] = useState(false);

  const { execute: listExec, isLoading } = useApiCall<ListResponse>();
  const inviteApi = useApiCall<unknown>();
  const memberApi = useApiCall<{ stages_paused?: number; sessions_revoked?: boolean }>();
  const revokeApi = useApiCall<unknown>();

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let active = true;
    void (async () => {
      const r = await listExec("/api/users/list");
      if (active && r.ok) setData(r.data);
    })();
    return () => {
      active = false;
    };
  }, [tick, listExec]);

  const onInvite = useCallback(async () => {
    const r = await inviteApi.execute("/api/users/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    if (!r.ok) {
      toastApiError(r, "Couldn't send that invite");
      return;
    }
    toast.success(`${inviteEmail} can now sign in with Google.`);
    setInviteOpen(false);
    setInviteEmail("");
    setInviteRole("viewer");
    refresh();
  }, [inviteApi, inviteEmail, inviteRole, refresh]);

  const changeRole = useCallback(
    async (member: MemberRow, role: string) => {
      const r = await memberApi.execute(`/api/users/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!r.ok) {
        toastApiError(r, "Couldn't change that role");
        return;
      }
      toast.success(`${member.email ?? "Member"} is now ${role}.`);
      refresh();
    },
    [memberApi, refresh],
  );

  const setActive = useCallback(
    async (member: MemberRow, isActive: boolean) => {
      const r = await memberApi.execute(`/api/users/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: isActive }),
      });
      if (!r.ok) {
        toastApiError(r, "Couldn't change that member's access");
        return;
      }
      if (isActive) {
        toast.success(`${member.email ?? "Member"} can sign in again.`);
      } else {
        const paused = r.data?.stages_paused ?? 0;
        // Surface the session-revocation outcome explicitly: it is best-effort
        // (Supabase Admin may be unreachable) and an owner needs to know if it
        // did not happen, because that is the half that stops an existing
        // session rather than the next request.
        const revoked = r.data?.sessions_revoked;
        toast.success(
          `Access cut. ${paused} unsent stage${paused === 1 ? "" : "s"} un-approved.` +
            (revoked === false
              ? " Session revocation FAILED — check Supabase."
              : ""),
        );
      }
      setConfirmTarget(null);
      refresh();
    },
    [memberApi, refresh],
  );

  const revokeInvite = useCallback(
    async (invite: InviteRow) => {
      const r = await revokeApi.execute(`/api/users/invites/${invite.id}`, {
        method: "DELETE",
      });
      if (!r.ok) {
        toastApiError(r, "Couldn't revoke that invite");
        return;
      }
      toast.success(`Invite for ${invite.email} revoked.`);
      refresh();
    },
    [revokeApi, refresh],
  );

  if (isLoading && !data) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading members…
      </div>
    );
  }

  const members = data?.members ?? [];
  const invites = data?.invites ?? [];

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Button onClick={() => setInviteOpen(true)}>
          <UserPlus className="size-4" aria-hidden />
          Invite someone
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-left">
                <tr>
                  <th className="px-4 py-2 font-medium">Member</th>
                  <th className="px-4 py-2 font-medium">Role</th>
                  <th className="px-4 py-2 font-medium">Last login</th>
                  <th className="px-4 py-2 font-medium">Last IP</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">API</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const isSelf = m.user_id === auth?.user.id;
                  const isOwner = m.role === "owner";
                  return (
                    <tr key={m.id} className="border-b last:border-0">
                      <td className="px-4 py-2">
                        <span className="font-medium">{m.email ?? "—"}</span>
                        {isSelf ? (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            You
                          </Badge>
                        ) : null}
                      </td>
                      <td className="px-4 py-2">
                        {isOwner || isSelf ? (
                          <span className="text-muted-foreground">{m.role}</span>
                        ) : (
                          <Select
                            value={m.role}
                            onValueChange={(v) => void changeRole(m, v)}
                          >
                            <SelectTrigger className="h-8 w-[130px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ASSIGNABLE_ROLES.map((r) => (
                                <SelectItem key={r} value={r}>
                                  {r}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {m.last_login_at
                          ? formatCampaignDateTime(m.last_login_at)
                          : "Never"}
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                        {m.last_login_ip ?? "—"}
                      </td>
                      <td className="px-4 py-2">
                        {m.is_active ? (
                          <Badge variant="outline">Active</Badge>
                        ) : (
                          <Badge variant="destructive">Deactivated</Badge>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {/* One button, not a switch: the switch itself lives in
                            the sheet next to the tokens it governs, because "API
                            on" and "has a live token" are two conditions that
                            only make sense read together. */}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setApiTarget(m)}
                        >
                          <KeyRound className="size-4" aria-hidden />
                          {m.api_enabled ? "On" : "Off"}
                          {m.live_tokens > 0 ? (
                            <Badge variant="outline" className="ml-1 text-[10px]">
                              {m.live_tokens}
                            </Badge>
                          ) : null}
                        </Button>
                      </td>
                      <td className="px-4 py-2 text-right">
                        {/* Link Google account — OWNER ONLY and SELF ONLY.
                            linkIdentity() acts on whoever is signed in, so it
                            is structurally impossible to link an identity onto
                            somebody else's account; the row check keeps the
                            button honest about that rather than implying a
                            capability that does not exist. Hidden once the
                            account already has a Google identity. */}
                        {isSelf && isOwner && !m.has_google ? (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={linking}
                            onClick={async () => {
                              setLinking(true);
                              // Redirects to Google on success and never
                              // returns, so `linking` is only reset on error.
                              const r = await linkGoogleIdentityAction();
                              if (r?.error) {
                                toast.error(r.error);
                                setLinking(false);
                              }
                            }}
                          >
                            <Link2 className="size-4" aria-hidden />
                            {linking ? "Redirecting…" : "Link Google account"}
                          </Button>
                        ) : null}
                        {isSelf && m.has_google ? (
                          <Badge variant="outline" className="text-[10px]">
                            Google linked
                          </Badge>
                        ) : null}
                        {isSelf ? null : m.is_active ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setConfirmTarget(m)}
                          >
                            <ShieldOff className="size-4" aria-hidden />
                            Deactivate
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void setActive(m, true)}
                          >
                            Reactivate
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <div>
        <h2 className="mb-2 text-sm font-semibold">Pending invites</h2>
        {invites.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No open invites. Invited people appear here until they first sign in.
          </p>
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <tbody>
                  {invites.map((i) => (
                    <tr key={i.id} className="border-b last:border-0">
                      <td className="px-4 py-2 font-medium">{i.email}</td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {i.role}
                      </td>
                      <td className="px-4 py-2">
                        {i.expired ? (
                          <Badge variant="destructive">Expired</Badge>
                        ) : (
                          <span className="text-muted-foreground">
                            Expires {formatCampaignDateTime(i.expires_at)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void revokeInvite(i)}
                        >
                          Revoke
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </div>

      <FormDialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogHeader>
          <DialogTitle>Invite someone</DialogTitle>
          <DialogDescription>
            They sign in with Google — there is no password to set, and no email
            is sent from here. Tell them to open Campaign Manager and use “Sign
            in with Google”.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="invite-email">
              Work email
              <span aria-hidden className="ml-0.5 text-destructive">
                *
              </span>
            </Label>
            <Input
              id="invite-email"
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="name@exuma.io"
              autoComplete="off"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="invite-role">
              Role
              <span aria-hidden className="ml-0.5 text-destructive">
                *
              </span>
            </Label>
            <Select value={inviteRole} onValueChange={setInviteRole}>
              <SelectTrigger id="invite-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ASSIGNABLE_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {inviteRole === "operator" ? (
              <p className="text-xs text-muted-foreground">
                Campaigns, stages, creatives and segments. No contact data, no
                exports or imports, no compliance controls.
              </p>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void onInvite()}
              disabled={inviteApi.isLoading || inviteEmail.trim() === ""}
            >
              {inviteApi.isLoading ? "Inviting…" : "Send invite"}
            </Button>
          </div>
        </div>
      </FormDialog>

      {apiTarget ? (
        <UserApiPanel
          memberId={apiTarget.id}
          memberLabel={apiTarget.email ?? apiTarget.user_id}
          apiEnabled={apiTarget.api_enabled}
          open={apiTarget !== null}
          onOpenChange={(o) => !o && setApiTarget(null)}
          onChanged={refresh}
        />
      ) : null}

      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(o) => !o && setConfirmTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Cut access for {confirmTarget?.email ?? "this member"}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Their sessions are revoked and they lose access on their very
                  next request.
                </p>
                {confirmTarget && confirmTarget.pending_stages > 0 ? (
                  <p className="font-medium text-destructive">
                    {confirmTarget.pending_stages} approved stage
                    {confirmTarget.pending_stages === 1 ? "" : "s"} they created
                    {confirmTarget.pending_stages === 1 ? " has" : " have"} not
                    sent yet and will be un-approved. Re-approving is manual.
                  </p>
                ) : (
                  <p>They have no approved, unsent stages.</p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                confirmTarget && void setActive(confirmTarget, false)
              }
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
