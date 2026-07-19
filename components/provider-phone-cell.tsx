import { formatPhoneInternational } from "@/lib/phone-validation";

// Shared "Provider / Phone" cell — a colored provider dot + name with the number
// beneath (short codes shown raw, else internationally formatted). Extracted from
// the campaigns list column so the campaigns table and the by-number performance
// report render identically. Multi-value collapses to "N providers" / "N numbers".
export interface ProviderPhoneCellProvider {
  name: string;
  color?: string | null;
}
export interface ProviderPhoneCellPhone {
  phone_number: string;
  number_type?: string | null;
}

export function ProviderPhoneCell({
  providers,
  phones,
}: {
  providers: ProviderPhoneCellProvider[];
  phones: ProviderPhoneCellPhone[];
}) {
  if (providers.length === 0 && phones.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {providers.length === 1 ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: providers[0].color ?? "#64748B" }}
          />
          <span className="text-sm">{providers[0].name}</span>
        </span>
      ) : providers.length > 1 ? (
        <span className="text-sm">{providers.length} providers</span>
      ) : (
        <span className="text-sm text-muted-foreground">No provider</span>
      )}
      {phones.length === 1 ? (
        <span className="font-mono text-xs text-muted-foreground">
          {phones[0].number_type === "short_code"
            ? phones[0].phone_number
            : formatPhoneInternational(phones[0].phone_number)}
        </span>
      ) : phones.length > 1 ? (
        <span className="text-xs text-muted-foreground">
          {phones.length} numbers
        </span>
      ) : null}
    </div>
  );
}
