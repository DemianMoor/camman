"use client";

import { useEffect, useState } from "react";

import { type OfferForPicker, OfferPicker } from "@/components/offers/offer-picker";
import { OfferGroupReport } from "@/components/reports/offer-group-report";
import { Label } from "@/components/ui/label";
import { useApiCall } from "@/lib/hooks/use-api-call";

type OfferRow = OfferForPicker & { status: string };

// /reports/offer-groups ("Offers x Group") — the offer screen's Group Report
// behind an offer picker. The only control is the offer: the report itself is
// <OfferGroupReport>, unchanged (lifetime matview data, no date/group filters).
// Pins + recents share the "offers" namespace with the campaign editor and
// /creatives (localStorage, per browser — see lib/hooks/use-picker-prefs.ts).
export function OffersByGroupReport({ initialOfferId }: { initialOfferId: number | null }) {
  const offersApi = useApiCall<{ data: OfferRow[] }>();
  const [offers, setOffers] = useState<OfferForPicker[]>([]);
  const [offerId, setOfferId] = useState<number | null>(initialOfferId);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      // Active + archived: an archived offer's history is still reportable.
      const res = await offersApi.execute(
        "/api/offers/list?pageSize=500&showArchived=true&sortBy=name&sortDir=asc",
      );
      if (res.ok) {
        setOffers(
          res.data.data.map((o) => ({
            id: o.id,
            name: o.status === "archived" ? `${o.name} (archived)` : o.name,
            color: o.color,
          })),
        );
      } else setError(res.error);
    })();
    // .execute only — the whole hook in deps re-runs every render (fetch loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offersApi.execute]);

  function pickOffer(next: number | null) {
    setOfferId(next);
    window.history.replaceState(null, "", next == null ? window.location.pathname : `?offer=${next}`);
  }

  return (
    <div className="space-y-2">
      <div className="grid gap-1.5">
        <Label>Offer</Label>
        <OfferPicker
          offers={offers}
          value={offerId}
          onChange={pickOffer}
          isLoading={offersApi.isLoading && offers.length === 0}
          placeholder="Pick an offer"
          className="w-80"
        />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {offerId == null ? (
        <p className="py-6 text-sm text-muted-foreground">Pick an offer to see its results per contact group.</p>
      ) : (
        // key: a new offer remounts the report, so the previous offer's rows,
        // sort and lifecycle toggle never show under the new offer's name.
        <OfferGroupReport
          key={offerId}
          offerId={String(offerId)}
          heading={(offerName) => <h2 className="text-lg font-semibold">{offerName ?? "…"}</h2>}
        />
      )}
    </div>
  );
}
