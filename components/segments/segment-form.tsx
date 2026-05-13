"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

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
import { MultiSelectPicker } from "@/components/multi-select-picker";
import { useApiCall } from "@/lib/hooks/use-api-call";
import {
  segmentCreateSchema,
  type SegmentFormValues,
} from "@/lib/validators/segments";

export type { SegmentFormValues };

type GroupInfo = { id: number; name: string; color: string | null };
type GroupListResponse = { data: GroupInfo[] };

export interface SegmentFormProps {
  mode: "create" | "edit";
  initialValues?: Partial<SegmentFormValues>;
  onSubmit: (values: SegmentFormValues) => Promise<void>;
  onCancel: () => void;
  isSubmitting?: boolean;
}

export function SegmentForm({
  mode,
  initialValues,
  onSubmit,
  onCancel,
  isSubmitting,
}: SegmentFormProps) {
  const isEdit = mode === "edit";
  const groupsApi = useApiCall<GroupListResponse>();
  const [groups, setGroups] = useState<GroupInfo[]>([]);

  useEffect(() => {
    (async () => {
      const r = await groupsApi.execute("/api/segment-groups/list?pageSize=100");
      if (r.ok) setGroups(r.data.data);
    })();
  }, [groupsApi.execute]);

  const form = useForm<SegmentFormValues>({
    resolver: zodResolver(segmentCreateSchema),
    defaultValues: {
      name: initialValues?.name ?? "",
      segment_id: initialValues?.segment_id ?? "",
      original_name: initialValues?.original_name ?? "",
      segment_group_ids: initialValues?.segment_group_ids ?? [],
    },
  });

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
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input
                  placeholder="e.g. Q1 prospect list"
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
          name="segment_id"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Segment ID</FormLabel>
              <FormControl>
                <Input
                  placeholder="q1-prospects"
                  disabled={isEdit || isSubmitting}
                  readOnly={isEdit}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                {isEdit
                  ? "Segment ID can't be changed after creation."
                  : "Letters, digits, hyphens, and underscores only."}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="segment_group_ids"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Groups (optional)</FormLabel>
              <FormControl>
                <MultiSelectPicker
                  options={groups.map((g) => ({
                    id: g.id,
                    label: g.name,
                    color: g.color,
                  }))}
                  value={field.value ?? []}
                  onChange={(next) => field.onChange(next as number[])}
                  placeholder="Select groups…"
                  selectedLabel={(n) =>
                    `${n} group${n === 1 ? "" : "s"} selected`
                  }
                  isLoading={groupsApi.isLoading && groups.length === 0}
                  disabled={isSubmitting}
                  emptyMessage="No groups available yet. Create one from Segment Groups."
                  searchPlaceholder="Search groups…"
                />
              </FormControl>
              <FormDescription>
                A segment can belong to multiple groups.
              </FormDescription>
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
