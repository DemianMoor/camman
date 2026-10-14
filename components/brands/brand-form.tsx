"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import type { z } from "zod";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { ColorPicker } from "@/components/color-picker";
import { useApiCall } from "@/lib/hooks/use-api-call";
import { brandCreateSchema } from "@/lib/validators/brands";

// We use the create schema for both modes. On edit, brand_id is rendered as a
// read-only input with its existing value, so it always validates.
const formSchema = brandCreateSchema;

export type BrandFormValues = z.infer<typeof formSchema>;

export interface BrandFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<BrandFormValues>;
  onSubmit: (values: BrandFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
  /** brands.landing.update (admin+). Without it the landing fields are read-only
   *  and the caller must not send them. */
  canEditLanding: boolean;
  /** The brand's numeric id on edit — lets "Test" pick a slug this brand uses. */
  brandDbId?: number;
}

type LandingTestResult = {
  url: string;
  slug: string;
  outcome:
    | "serves"
    | "redirects"
    | "not_found"
    | "blocked_by_bot_protection"
    | "error_status"
    | "refused_address"
    | "unreachable";
  status: number | null;
  location: string | null;
  detail: string | null;
};

const OUTCOME_TEXT: Record<LandingTestResult["outcome"], string> = {
  serves: "Serves",
  redirects: "Redirects",
  not_found: "Not found",
  blocked_by_bot_protection: "Blocked by bot protection — can't verify from the server",
  error_status: "Error",
  refused_address: "Refused (private or invalid address)",
  unreachable: "Unreachable",
};

export function BrandForm({
  mode,
  initialValues,
  onSubmit,
  onCancel,
  isSubmitting,
  canEditLanding,
  brandDbId,
}: BrandFormProps) {
  const testApi = useApiCall<LandingTestResult>();
  const [testResult, setTestResult] = useState<LandingTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const form = useForm<BrandFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: initialValues?.name ?? "",
      brand_id: initialValues?.brand_id ?? "",
      short_domain: initialValues?.short_domain ?? "",
      website: initialValues?.website ?? "",
      avatar_url: initialValues?.avatar_url ?? "",
      color: initialValues?.color ?? "",
      landing_host: initialValues?.landing_host ?? "",
      landing_path: initialValues?.landing_path ?? "lp",
    },
  });

  async function runLandingTest() {
    setTestResult(null);
    setTestError(null);
    const r = await testApi.execute("/api/brands/landing-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        host: form.getValues("landing_host") ?? "",
        path: form.getValues("landing_path") || "lp",
        ...(brandDbId ? { brand_id: brandDbId } : {}),
      }),
    });
    if (r.ok) setTestResult(r.data);
    else setTestError(r.error);
  }

  const watchedHost = useWatch({ control: form.control, name: "landing_host" });

  const isEdit = mode === "edit";

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="grid gap-4"
        noValidate
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Name</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. Acme Mobile"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="brand_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Brand ID</FormLabel>
              <FormControl>
                <Input
                  placeholder="acme-mobile"
                  disabled={isEdit || isSubmitting}
                  readOnly={isEdit}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                {isEdit
                  ? "Brand ID can't be changed after creation."
                  : "Letters, digits, hyphens, and underscores only. Used as an external identifier."}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* The "Short domain" text input that lived here is GONE. A brand may
            hold several short domains (migration 0136), so a single field could
            not express the shape — and the upsert behind it was broken outright
            by that same migration. Domains are managed on their own surface
            (Settings → Short domains), where each is added as `pending` and
            activated deliberately. Removing the field is what guarantees no
            second write path survives. */}

        <FormField
          control={form.control}
          name="website"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Main website</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://www.brand.com"
                  disabled={isSubmitting}
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormDescription>
                Where the short domain&apos;s bare root redirects to.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="landing_host"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Landing host</FormLabel>
              <FormControl>
                <Input
                  placeholder="www.brand.com"
                  disabled={isSubmitting || !canEditLanding}
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormDescription>
                {!(watchedHost ?? "").trim()
                  ? "Required for slug-based landing pages."
                  : "Slug landing pages link to https://<host>/<path>/<slug>."}
                {!canEditLanding ? " Only an admin can change this." : ""}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="landing_path"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Landing path</FormLabel>
              <FormControl>
                <Input
                  placeholder="lp"
                  disabled={isSubmitting || !canEditLanding}
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormDescription>
                Lowercase letters, digits and inner dashes, no slashes. Default <span className="font-mono">lp</span>.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {canEditLanding ? (
          <div className="grid gap-1.5">
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void runLandingTest()}
                disabled={isSubmitting || testApi.isLoading || !(watchedHost ?? "").trim()}
              >
                {testApi.isLoading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                Test landing URL
              </Button>
            </div>
            {testResult ? (
              <p className="text-xs" aria-live="polite">
                <span className={testResult.outcome === "serves" ? "text-emerald-600" : "text-destructive"}>
                  {OUTCOME_TEXT[testResult.outcome]}
                  {testResult.status ? ` (${testResult.status})` : ""}
                </span>{" "}
                <span className="text-muted-foreground font-mono break-all">{testResult.url}</span>
                {testResult.location ? (
                  <span className="text-muted-foreground"> → {testResult.location}</span>
                ) : null}
              </p>
            ) : null}
            {testError ? (
              <p className="text-destructive text-xs" aria-live="polite">{testError}</p>
            ) : null}
          </div>
        ) : null}

        <FormField
          control={form.control}
          name="avatar_url"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Avatar URL</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://…"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="color"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Color</FormLabel>
              <FormControl>
                <ColorPicker
                  value={field.value || null}
                  onChange={(c) => field.onChange(c ?? "")}
                  disabled={isSubmitting}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            {isEdit ? "Save changes" : "Create"}
          </Button>
        </div>
      </form>
    </Form>
  );
}
