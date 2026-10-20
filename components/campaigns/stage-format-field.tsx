"use client";

import { useRef } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { NEW_ROW, validateCustomText } from "@/lib/messages/format";
import type { MessageShape } from "@/lib/messages/render";

export type StageFormatOption = { id: number; name: string; template: string; is_enabled: boolean; is_default: boolean };

import { FORMAT_LOCKED_TEXT } from "@/lib/stages/lock-copy";

const CUSTOM = "custom";
const CUSTOM_BLOCKS = ["{creative_text}", "{url}", "{stop_text}", "{brand}", NEW_ROW] as const;

/**
 * The stage's message shape from the form state. A NULL format id on a new
 * stage means "the org default" (the 0216 trigger stamps it on save), so the
 * preview uses the default too.
 */
export function stageShapeFromForm(
  formats: StageFormatOption[],
  messageFormatId: number | null,
  customText: string | null,
): MessageShape | null {
  if (customText != null) return { kind: "custom", text: customText };
  const f = formats.find((x) => x.id === messageFormatId) ?? formats.find((x) => x.is_default);
  return f ? { kind: "template", formatId: f.id, template: f.template } : null;
}

/** Spec B5 warnings — shown, never blocking. */
export function formatWarnings(shape: MessageShape | null, creativeText: string | null | undefined): string[] {
  if (!shape || !creativeText) return [];
  const creativeHasBrand = creativeText.includes("{brand}");
  const shapeText = shape.kind === "custom" ? shape.text : shape.template;
  const shapeHasBrand = shapeText.includes("{brand}");
  if (creativeHasBrand && shapeHasBrand) return ["Brand appears twice"];
  if (!creativeHasBrand && !shapeHasBrand) return ["This format has no brand — the creative doesn't contain {brand}"];
  return [];
}

/**
 * Message format picker (0216). Operators pick from ENABLED formats; "Custom"
 * (free-form message with {creative_text} {url} {stop_text}) is owner-only.
 * Both lock once the stage has sent.
 */
export function StageFormatField({
  formats,
  messageFormatId,
  customText,
  onChange,
  canCustom,
  locked,
  disabled,
}: {
  formats: StageFormatOption[];
  messageFormatId: number | null;
  customText: string | null;
  onChange: (next: { message_format_id: number | null; custom_text: string | null }) => void;
  canCustom: boolean;
  locked: boolean;
  disabled: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const isCustom = customText != null;
  const defaultId = formats.find((f) => f.is_default)?.id ?? null;
  const selectedId = messageFormatId ?? defaultId;
  // A stage keeps showing its format even if it was disabled since; new picks
  // are enabled formats only.
  const options = formats.filter((f) => f.is_enabled || f.id === selectedId);
  const value = isCustom ? CUSTOM : selectedId != null ? String(selectedId) : "";
  const customError = isCustom ? validateCustomText(customText) : null;
  // Custom text is owner territory: a non-owner can neither pick it nor leave it.
  const pickerDisabled = disabled || locked || (isCustom && !canCustom);

  const insert = (token: string) => {
    const el = ref.current;
    if (!el) return;
    el.setRangeText(token, el.selectionStart, el.selectionEnd, "end");
    onChange({ message_format_id: null, custom_text: el.value });
    el.focus();
  };

  return (
    <div className="grid gap-2">
      <Label>Message format</Label>
      <Select
        value={value}
        disabled={pickerDisabled}
        onValueChange={(v) =>
          v === CUSTOM
            ? onChange({ message_format_id: null, custom_text: customText ?? "{creative_text}<new_row>{url}<new_row>{stop_text}" })
            : onChange({ message_format_id: Number(v), custom_text: null })
        }
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Default format" />
        </SelectTrigger>
        <SelectContent>
          {options.map((f) => (
            <SelectItem key={f.id} value={String(f.id)}>
              {f.name}
              {f.is_default ? " (default)" : ""}
              {!f.is_enabled ? " (disabled)" : ""}
            </SelectItem>
          ))}
          {canCustom || isCustom ? <SelectItem value={CUSTOM}>Custom message</SelectItem> : null}
        </SelectContent>
      </Select>
      {locked ? <p className="text-xs text-muted-foreground">{FORMAT_LOCKED_TEXT}</p> : null}

      {isCustom ? (
        <div className="grid gap-1">
          {canCustom && !locked ? (
            <div className="flex flex-wrap gap-1">
              {CUSTOM_BLOCKS.map((b) => (
                <Button key={b} type="button" variant="outline" size="sm" disabled={disabled} onClick={() => insert(b)}>
                  Insert {b}
                </Button>
              ))}
            </div>
          ) : null}
          <Textarea
            ref={ref}
            rows={3}
            className="font-mono text-xs"
            value={customText}
            readOnly={!canCustom || locked}
            disabled={disabled}
            onChange={(e) => onChange({ message_format_id: null, custom_text: e.target.value })}
          />
          {customError ? (
            <p className="text-xs text-destructive">
              Custom text must contain {"{creative_text}"}, {"{url}"} and {"{stop_text}"} — {customError.detail} is missing.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
