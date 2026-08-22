"use client";

import { useCallback, useEffect, useState } from "react";
import { format } from "date-fns";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CopyableId } from "@/components/ui/copyable-id";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiCall } from "@/lib/hooks/use-api-call";
import {
  AGE_BAND_LABELS,
  ATTRIBUTE_FIELDS,
  INCOME_BAND_LABELS,
} from "@/lib/contact-attributes";

// Contact detail (Drip Phase 1, item 1c).
//
// There was no per-contact page before this — /contacts was a list only, with
// nothing linking to a detail route. contact_attributes (0147) needed somewhere
// to live, and Drip Phases 4–7 all want a per-contact view (journey state, send
// history, opt-out provenance), so this is built as a real page rather than a
// drawer on the list row.

type Attributes = Record<string, string | boolean | null>;

interface ContactDetail {
  id: string;
  phone_number: string;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  line_type: string;
  carrier_norm: string;
  messaging_status: string;
  attributes: Attributes | null;
  age: number | null;
  age_band: string | null;
  groups: { id: number; name: string; color: string | null }[];
  opt_outs: { reason: string; created_at: string }[];
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="truncate text-sm">{value}</dd>
    </div>
  );
}

// A boolean attribute is TRI-state: true / false / unknown. Rendering NULL as
// "No" would invent data — an unknown is not a negative, and a segment rule
// treats the two differently (an unknown matches neither yes nor no).
function renderValue(field: string, v: string | boolean | null): React.ReactNode {
  if (v === null || v === undefined || v === "") {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (field === "income_band") return INCOME_BAND_LABELS[v] ?? v;
  if (field === "dob") return String(v).slice(0, 10);
  return String(v);
}

export default function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApiCall<ContactDetail>();
  const [contact, setContact] = useState<ContactDetail | null>(null);
  const [notFound, setNotFound] = useState(false);

  const load = useCallback(async () => {
    const r = await api.execute(`/api/contacts/${id}`);
    if (r.ok) setContact(r.data);
    else setNotFound(true);
  }, [api.execute, id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (notFound) {
    return (
      <div className="space-y-4">
        <Link href="/contacts">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1 size-4" /> Contacts
          </Button>
        </Link>
        <Card>
          <CardContent className="py-10 text-center text-sm">Contact not found.</CardContent>
        </Card>
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const attrs = contact.attributes;
  const optedOut = contact.opt_outs.length > 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/contacts">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-1 size-4" /> Contacts
          </Button>
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">{contact.phone_number}</h1>
        {/* messaging_status is trigger-derived from line_type; a landline is
            not_applicable and can never be sent to, so it is surfaced as a
            first-class badge rather than buried in the enrichment block. */}
        {contact.messaging_status !== "eligible" && (
          <Badge variant="secondary">{contact.messaging_status}</Badge>
        )}
        {contact.is_archived && <Badge variant="outline">Archived</Badge>}
        {optedOut && (
          <Badge variant="destructive" className="gap-1">
            <ShieldAlert className="size-3" /> Opted out
          </Badge>
        )}
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 pt-6 md:grid-cols-4">
          <Field label="Line type" value={contact.line_type} />
          <Field label="Carrier" value={contact.carrier_norm} />
          <Field label="First seen" value={format(new Date(contact.created_at), "d MMM yyyy")} />
          <Field label="Updated" value={format(new Date(contact.updated_at), "d MMM yyyy")} />
          <div className="col-span-2 md:col-span-4">
            <CopyableId value={contact.id} label="Contact ID" />
          </div>
        </CardContent>
      </Card>

      {contact.groups.length > 0 && (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-2 pt-6">
            <span className="text-muted-foreground text-xs">Groups</span>
            {contact.groups.map((g) => (
              <Badge key={g.id} variant="secondary">
                {g.name}
              </Badge>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-6">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-medium">Attributes</h2>
            {attrs?.updated_at && (
              <span className="text-muted-foreground text-xs">
                updated {format(new Date(String(attrs.updated_at)), "d MMM yyyy")}
              </span>
            )}
          </div>

          {!attrs ? (
            // Deliberately distinct from "every field is blank": no attributes
            // row at all means no segment rule over attributes can match this
            // contact, which is worth saying plainly.
            <p className="text-muted-foreground text-sm">
              No attributes recorded. This contact matches no attribute-based segment rule.
            </p>
          ) : (
            <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {ATTRIBUTE_FIELDS.map(({ field, label }) => (
                <Field key={field} label={label} value={renderValue(field, attrs[field] ?? null)} />
              ))}
              {/* Age is DERIVED at read time, never stored — a stored age is
                  wrong the day after it is written. The band is null for
                  anyone under 18: there is no under-18 band, mirroring the
                  hard floor the age_band segment rule applies in SQL. */}
              <Field
                label="Age (derived)"
                value={
                  contact.age === null ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <>
                      {contact.age}
                      {contact.age_band ? (
                        <span className="text-muted-foreground">
                          {" "}
                          · {AGE_BAND_LABELS[contact.age_band as keyof typeof AGE_BAND_LABELS]}
                        </span>
                      ) : (
                        <span className="text-muted-foreground"> · under 18, not targetable</span>
                      )}
                    </>
                  )
                }
              />
              {attrs.source && <Field label="Source" value={String(attrs.source)} />}
            </dl>
          )}
        </CardContent>
      </Card>

      {optedOut && (
        <Card>
          <CardContent className="pt-6">
            <h2 className="mb-2 text-sm font-medium">Suppression</h2>
            <ul className="space-y-1 text-sm">
              {contact.opt_outs.map((o, i) => (
                <li key={i} className="flex gap-3">
                  <Badge variant="outline">{o.reason}</Badge>
                  <span className="text-muted-foreground">
                    {format(new Date(o.created_at), "d MMM yyyy HH:mm")}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
