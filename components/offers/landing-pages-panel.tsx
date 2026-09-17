"use client";

import { useEffect, useState } from "react";
import { Pencil, Plus, Star, StarOff } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { LANDING_PAGE_IN_USE_CODE, type LandingPageKind } from "@/lib/landing-page-edit";

// Landing pages for one offer (Drip P1 1b).
//
// A landing page says WHICH PAGE, not which URL. For kind='slug' the host comes
// from the CAMPAIGN's brand at mint time — which is why one 'Monks' page here
// replaces the three near-identical sales pages operators maintain today
// (`gdkn-Monks`, `lmzn-Monks`, `fty-Monks` on offer 58) and why re-branding a
// campaign fixes its links instead of orphaning them.
//
// There is no Delete: a page is referenced by stages, and deleting it would
// SET NULL and silently drop them back to the legacy absolute-URL path. Disable
// instead — the slug stays reserved, so links already in the wild keep meaning
// what they meant.
//
// Title, kind, slug and URL are editable in place. Because the destination is
// built at mint time, editing it reaches every stage that hasn't sent yet — the
// server answers 409 landing_page_in_use with the counts, and the edit only
// lands once the confirm dialog below resends it with `confirm: true`.

interface LandingPage {
  id: number;
  title: string;
  kind: LandingPageKind;
  slug: string | null;
  external_url: string | null;
  is_default: boolean;
  status: string;
}

interface Draft {
  title: string;
  kind: LandingPageKind;
  slug: string;
  externalUrl: string;
}

const EMPTY_DRAFT: Draft = { title: "", kind: "slug", slug: "", externalUrl: "" };

// Lowercase alphanumerics only. An underscore is the exact signature of the
// tracking-id-in-path bug 0094 exists to stop, so it is rejected here, in Zod,
// and by a DB CHECK.
const SLUG_RE = /^[a-z0-9]+$/;

function isDraftValid(d: Draft) {
  return (
    d.title.trim().length > 0 &&
    (d.kind === "slug" ? SLUG_RE.test(d.slug.trim()) : d.externalUrl.trim().length > 0)
  );
}

// Only the target kind's value is sent — the other column is cleared server-side.
function draftBody(d: Draft) {
  return d.kind === "slug"
    ? { title: d.title.trim(), kind: d.kind, slug: d.slug.trim() }
    : { title: d.title.trim(), kind: d.kind, external_url: d.externalUrl.trim() };
}

function draftFromPage(p: LandingPage): Draft {
  return { title: p.title, kind: p.kind, slug: p.slug ?? "", externalUrl: p.external_url ?? "" };
}

function LandingPageFields({
  idPrefix,
  draft,
  onChange,
}: {
  idPrefix: string;
  draft: Draft;
  onChange: (d: Draft) => void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  return (
    <>
      <div className="grid gap-2 sm:grid-cols-[1fr_150px]">
        <div>
          <Label htmlFor={`${idPrefix}-title`} className="text-xs">
            Title<span aria-hidden className="text-destructive ml-0.5">*</span>
          </Label>
          <Input
            id={`${idPrefix}-title`}
            value={draft.title}
            onChange={(e) => set({ title: e.target.value })}
            placeholder="e.g. Monks"
          />
        </div>
        <div>
          <Label className="text-xs">Kind</Label>
          <Select value={draft.kind} onValueChange={(v) => set({ kind: v as LandingPageKind })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="slug">Brand slug</SelectItem>
              <SelectItem value="external_url">External URL</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {draft.kind === "slug" ? (
        <div>
          <Label htmlFor={`${idPrefix}-slug`} className="text-xs">
            Slug<span aria-hidden className="text-destructive ml-0.5">*</span>
          </Label>
          <Input
            id={`${idPrefix}-slug`}
            value={draft.slug}
            onChange={(e) => set({ slug: e.target.value.toLowerCase() })}
            placeholder="orv"
            className="font-mono"
          />
          {draft.slug.trim().length > 0 && !SLUG_RE.test(draft.slug.trim()) && (
            <p className="text-destructive mt-1 text-xs">
              Lowercase letters and digits only — no dashes or underscores.
            </p>
          )}
        </div>
      ) : (
        <div>
          <Label htmlFor={`${idPrefix}-url`} className="text-xs">
            URL<span aria-hidden className="text-destructive ml-0.5">*</span>
          </Label>
          <Input
            id={`${idPrefix}-url`}
            value={draft.externalUrl}
            onChange={(e) => set({ externalUrl: e.target.value })}
            placeholder="https://partner.example/offer"
          />
          <p className="text-muted-foreground mt-1 text-xs">
            Used verbatim for any brand. UTM tags still apply here.
          </p>
        </div>
      )}
    </>
  );
}

export function LandingPagesPanel({
  offerId,
  canEdit,
}: {
  offerId: number;
  canEdit: boolean;
}) {
  const listApi = useApiCall<{ data: LandingPage[] }>();
  const mutateApi = useApiCall<LandingPage>();
  const [pages, setPages] = useState<LandingPage[]>([]);
  const [tick, setTick] = useState(0);

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [editing, setEditing] = useState<{ id: number; draft: Draft } | null>(null);
  const [confirming, setConfirming] = useState<{
    page: LandingPage;
    draft: Draft;
    affected: number;
    committed: number;
  } | null>(null);

  useEffect(() => {
    (async () => {
      const r = await listApi.execute(`/api/offers/${offerId}/landing-pages`);
      if (r.ok) setPages(r.data.data);
    })();
  }, [listApi.execute, offerId, tick]);

  const reload = () => setTick((n) => n + 1);

  const add = async () => {
    const body = draftBody(draft);
    const r = await mutateApi.execute(`/api/offers/${offerId}/landing-pages`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (r.ok) {
      toast.success(`Added "${body.title}"`);
      setDraft(EMPTY_DRAFT);
      reload();
    } else {
      toast.error(r.error ?? "Could not add the landing page");
    }
  };

  const patch = async (p: LandingPage, body: Record<string, unknown>, ok: string) => {
    const r = await mutateApi.execute(`/api/offers/${offerId}/landing-pages/${p.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    if (r.ok) {
      toast.success(ok);
      reload();
    } else {
      toast.error(r.error ?? "Could not update the landing page");
    }
  };

  const saveEdit = async (p: LandingPage, d: Draft, confirm: boolean) => {
    const body = { ...draftBody(d), ...(confirm ? { confirm: true } : {}) };
    const r = await mutateApi.execute(`/api/offers/${offerId}/landing-pages/${p.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    if (r.ok) {
      toast.success(`Saved "${body.title}"`);
      setEditing(null);
      setConfirming(null);
      reload();
      return;
    }
    if (r.code === LANDING_PAGE_IN_USE_CODE) {
      const counts = r.details as { affected: number; committed: number };
      setConfirming({ page: p, draft: d, affected: counts.affected, committed: counts.committed });
      return;
    }
    setConfirming(null);
    toast.error(r.error ?? "Could not update the landing page");
  };

  return (
    <div className="space-y-3">
      <div>
        <Label>Landing pages</Label>
        <p className="text-muted-foreground text-xs">
          A slug page builds <span className="font-mono">https://&lt;brand host&gt;/lp/&lt;slug&gt;</span>{" "}
          from the campaign&apos;s brand when the link is created — one page serves every brand.
        </p>
      </div>

      {pages.length === 0 ? (
        <p className="text-muted-foreground text-sm">No landing pages yet.</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {pages.map((p) =>
            editing?.id === p.id ? (
              <li key={p.id} className="space-y-2 px-3 py-2 text-sm">
                <LandingPageFields
                  idPrefix={`lp-edit-${p.id}`}
                  draft={editing.draft}
                  onChange={(d) => setEditing({ id: p.id, draft: d })}
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={!isDraftValid(editing.draft) || mutateApi.isLoading}
                    onClick={() => void saveEdit(p, editing.draft, false)}
                  >
                    Save
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={mutateApi.isLoading}
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </li>
            ) : (
              <li key={p.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{p.title}</span>
                    {p.is_default && <Badge variant="secondary">default</Badge>}
                    {p.status !== "active" && <Badge variant="outline">disabled</Badge>}
                  </div>
                  <div className="text-muted-foreground truncate font-mono text-xs">
                    {p.kind === "slug" ? `/lp/${p.slug}` : p.external_url}
                  </div>
                </div>
                {canEdit && (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Edit"
                      title="Edit"
                      disabled={mutateApi.isLoading}
                      onClick={() => setEditing({ id: p.id, draft: draftFromPage(p) })}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={p.is_default ? "Already default" : "Make default"}
                      title={p.is_default ? "Already default" : "Make default"}
                      disabled={p.is_default || p.status !== "active" || mutateApi.isLoading}
                      onClick={() => void patch(p, { is_default: true }, `"${p.title}" is now the default`)}
                    >
                      {p.is_default ? <Star className="size-4" /> : <StarOff className="size-4" />}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={mutateApi.isLoading}
                      onClick={() =>
                        void patch(
                          p,
                          { status: p.status === "active" ? "disabled" : "active" },
                          p.status === "active" ? `"${p.title}" disabled` : `"${p.title}" enabled`,
                        )
                      }
                    >
                      {p.status === "active" ? "Disable" : "Enable"}
                    </Button>
                  </>
                )}
              </li>
            ),
          )}
        </ul>
      )}

      {canEdit && (
        <div className="space-y-2 rounded-md border p-3">
          <LandingPageFields idPrefix="lp" draft={draft} onChange={setDraft} />
          <Button
            type="button"
            size="sm"
            disabled={!isDraftValid(draft) || mutateApi.isLoading}
            onClick={() => void add()}
          >
            <Plus className="mr-1 size-4" /> Add landing page
          </Button>
        </div>
      )}

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change where this landing page sends?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirming?.affected} stage(s) that haven&apos;t sent yet use &ldquo;{confirming?.page.title}
              &rdquo; ({confirming?.committed} approved, scheduled or dripping). Their future messages will
              link to the new destination. Messages already sent keep their old link.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutateApi.isLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (confirming) void saveEdit(confirming.page, confirming.draft, true);
              }}
              disabled={mutateApi.isLoading}
            >
              Change destination
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
