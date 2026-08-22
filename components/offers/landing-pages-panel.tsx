"use client";

import { useEffect, useState } from "react";
import { Plus, Star, StarOff } from "lucide-react";
import { toast } from "sonner";

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

interface LandingPage {
  id: number;
  title: string;
  kind: "slug" | "external_url";
  slug: string | null;
  external_url: string | null;
  is_default: boolean;
  status: string;
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

  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<"slug" | "external_url">("slug");
  const [slug, setSlug] = useState("");
  const [externalUrl, setExternalUrl] = useState("");

  useEffect(() => {
    (async () => {
      const r = await listApi.execute(`/api/offers/${offerId}/landing-pages`);
      if (r.ok) setPages(r.data.data);
    })();
  }, [listApi.execute, offerId, tick]);

  const reload = () => setTick((n) => n + 1);

  const add = async () => {
    const body =
      kind === "slug"
        ? { title: title.trim(), kind, slug: slug.trim() }
        : { title: title.trim(), kind, external_url: externalUrl.trim() };
    const r = await mutateApi.execute(`/api/offers/${offerId}/landing-pages`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (r.ok) {
      toast.success(`Added "${title.trim()}"`);
      setTitle("");
      setSlug("");
      setExternalUrl("");
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

  const canAdd =
    canEdit &&
    title.trim().length > 0 &&
    (kind === "slug" ? /^[a-z0-9]+$/.test(slug.trim()) : externalUrl.trim().length > 0);

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
          {pages.map((p) => (
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
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="space-y-2 rounded-md border p-3">
          <div className="grid gap-2 sm:grid-cols-[1fr_150px]">
            <div>
              <Label htmlFor="lp-title" className="text-xs">
                Title<span aria-hidden className="text-destructive ml-0.5">*</span>
              </Label>
              <Input id="lp-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Monks" />
            </div>
            <div>
              <Label className="text-xs">Kind</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as "slug" | "external_url")}>
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
          {kind === "slug" ? (
            <div>
              <Label htmlFor="lp-slug" className="text-xs">
                Slug<span aria-hidden className="text-destructive ml-0.5">*</span>
              </Label>
              <Input
                id="lp-slug"
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                placeholder="orv"
                className="font-mono"
              />
              {/* Lowercase alphanumerics only. An underscore is the exact
                  signature of the tracking-id-in-path bug 0094 exists to stop,
                  so it is rejected here, in Zod, and by a DB CHECK. */}
              {slug.trim().length > 0 && !/^[a-z0-9]+$/.test(slug.trim()) && (
                <p className="text-destructive mt-1 text-xs">
                  Lowercase letters and digits only — no dashes or underscores.
                </p>
              )}
            </div>
          ) : (
            <div>
              <Label htmlFor="lp-url" className="text-xs">
                URL<span aria-hidden className="text-destructive ml-0.5">*</span>
              </Label>
              <Input
                id="lp-url"
                value={externalUrl}
                onChange={(e) => setExternalUrl(e.target.value)}
                placeholder="https://partner.example/offer"
              />
              <p className="text-muted-foreground mt-1 text-xs">
                Used verbatim for any brand. UTM tags still apply here.
              </p>
            </div>
          )}
          <Button type="button" size="sm" disabled={!canAdd || mutateApi.isLoading} onClick={() => void add()}>
            <Plus className="mr-1 size-4" /> Add landing page
          </Button>
        </div>
      )}
    </div>
  );
}
