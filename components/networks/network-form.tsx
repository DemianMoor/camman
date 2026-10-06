"use client";

import { Loader2, Plus, X } from "lucide-react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
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
import {
  NO_RULES_COPY,
  RuleSelects,
  type EventTypeOption,
} from "@/components/networks/conversion-mapping";
import {
  DEFAULT_NETWORK_MAPPINGS,
  KEITARO_CONVERSION_TYPES,
} from "@/lib/validators/conversion-mappings";
import { networkCreateWithMappingsSchema } from "@/lib/validators/networks";

// `mappings` is used in create mode only; edit mode never sends it (rules are
// edited in the Conversion mapping dialog).
const formSchema = networkCreateWithMappingsSchema;
export type NetworkFormValues = z.infer<typeof formSchema>;
type MappingRow = NonNullable<NetworkFormValues["mappings"]>[number];

// The defaults, resolved to this org's event type ids. A default whose event
// type the org doesn't have is left out rather than guessed.
function defaultMappings(eventTypes: EventTypeOption[]): MappingRow[] {
  const rows: MappingRow[] = [];
  for (const d of DEFAULT_NETWORK_MAPPINGS) {
    const et = eventTypes.find((e) => e.key === d.event_type_key);
    if (et) {
      rows.push({
        keitaro_type: d.keitaro_type,
        event_type_id: et.id,
        conversion_status: d.conversion_status,
      });
    }
  }
  return rows;
}

export interface NetworkFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<NetworkFormValues>;
  onSubmit: (values: NetworkFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
  /** Required in create mode: feeds the pre-filled conversion mapping rules. */
  eventTypes?: EventTypeOption[];
}

export function NetworkForm({
  mode,
  initialValues,
  onSubmit,
  onCancel,
  isSubmitting,
  eventTypes = [],
}: NetworkFormProps) {
  const isEdit = mode === "edit";

  const form = useForm<NetworkFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: initialValues?.name ?? "",
      network_id: initialValues?.network_id ?? "",
      url: initialValues?.url ?? "",
      avatar_url: initialValues?.avatar_url ?? "",
      color: initialValues?.color ?? "",
      mappings: isEdit ? undefined : defaultMappings(eventTypes),
    },
  });
  const mappings = useFieldArray({ control: form.control, name: "mappings" });
  const watchedMappings = useWatch({ control: form.control, name: "mappings" }) ?? [];
  const usedTypes = new Set(watchedMappings.map((m) => m.keitaro_type));
  const freeTypes = KEITARO_CONVERSION_TYPES.filter((t) => !usedTypes.has(t));
  const mappingsError = form.formState.errors.mappings;

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
                  placeholder="e.g. MaxBounty"
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
          name="network_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel required>Network ID</FormLabel>
              <FormControl>
                <Input
                  placeholder="maxbounty"
                  disabled={isEdit || isSubmitting}
                  readOnly={isEdit}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                {isEdit
                  ? "Network ID can't be changed after creation."
                  : "Letters, digits, hyphens, and underscores only."}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="url"
          render={({ field }) => (
            <FormItem>
              <FormLabel>URL</FormLabel>
              <FormControl>
                <Input
                  placeholder="https://network.example.com"
                  disabled={isSubmitting}
                  {...field}
                  value={field.value ?? ""}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

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
                  value={field.value ?? ""}
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

        {!isEdit ? (
          <div className="grid gap-2">
            <div>
              <p className="text-sm font-medium">Conversion mapping</p>
              <p className="text-xs text-muted-foreground">
                How each Keitaro conversion type from this network is counted.
                The defaults fit most networks — change them only if this
                network differs.
              </p>
            </div>
            {mappings.fields.length === 0 ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                No rules. {NO_RULES_COPY}
              </p>
            ) : (
              <ul className="grid gap-2">
                {mappings.fields.map((field, i) => (
                  <li key={field.id} className="flex items-center gap-1">
                    <div className="min-w-0 flex-1">
                      <RuleSelects
                        keitaroType={watchedMappings[i]?.keitaro_type}
                        onKeitaroTypeChange={(t) =>
                          form.setValue(`mappings.${i}.keitaro_type`, t, { shouldValidate: true })
                        }
                        availableKeitaroTypes={KEITARO_CONVERSION_TYPES.filter(
                          (t) => t === watchedMappings[i]?.keitaro_type || !usedTypes.has(t),
                        )}
                        eventTypeId={watchedMappings[i]?.event_type_id}
                        onEventTypeChange={(id) =>
                          form.setValue(`mappings.${i}.event_type_id`, id, { shouldValidate: true })
                        }
                        status={watchedMappings[i]?.conversion_status}
                        onStatusChange={(st) =>
                          form.setValue(`mappings.${i}.conversion_status`, st, { shouldValidate: true })
                        }
                        eventTypes={eventTypes}
                        disabled={isSubmitting}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Remove rule"
                      onClick={() => mappings.remove(i)}
                      disabled={isSubmitting}
                    >
                      <X className="size-4" aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {mappingsError ? (
              <p className="text-sm text-destructive">
                {mappingsError.message ??
                  mappingsError.root?.message ??
                  "Complete or remove the incomplete rule"}
              </p>
            ) : null}
            {freeTypes.length > 0 ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="justify-self-start"
                disabled={isSubmitting}
                onClick={() =>
                  mappings.append({
                    keitaro_type: freeTypes[0],
                    event_type_id: undefined as unknown as number,
                    conversion_status: "approved",
                  })
                }
              >
                <Plus className="size-4" aria-hidden /> Add rule
              </Button>
            ) : null}
          </div>
        ) : null}

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
