"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { OfferGroupReport } from "@/components/reports/offer-group-report";

// The report body lives in components/reports/offer-group-report.tsx, shared
// with the /reports/offer-groups tab. This page adds only the back link + title.
export default function OfferGroupReportPage() {
  const params = useParams<{ id: string }>();
  return (
    <OfferGroupReport
      offerId={params.id}
      heading={(offerName) => (
        <>
          <Link href="/offers" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline">
            <ArrowLeft className="size-4" /> Offers
          </Link>
          <h1 className="text-xl font-semibold">
            Group Report{offerName ? ` — ${offerName}` : ""}
          </h1>
        </>
      )}
    />
  );
}
