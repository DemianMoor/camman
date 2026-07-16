import { and, asc, desc, eq, ilike, inArray } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { brands, provider_phones, sms_providers } from "@/db/schema";
import {
  apiError,
  isUniqueViolation,
  requireApiMembership,
} from "@/lib/api/helpers";
import { API_ERROR_CODES } from "@/lib/api/error-codes";
import { can } from "@/lib/permissions";
import { validatePhone } from "@/lib/phone-validation";
import { providerPhoneCreateSchema } from "@/lib/validators/provider-phones";

function parseId(idParam: string) {
  const n = Number(idParam);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

const SORT_COLUMNS = {
  phone_number: provider_phones.phone_number,
  cost_per_sms: provider_phones.cost_per_sms,
  created_at: provider_phones.created_at,
  status: provider_phones.status,
} as const;

const VALID_STATUSES = new Set([
  "active",
  "suspended",
  "blocked",
  "archived",
]);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "provider_phones.view")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId } = await params;
  const pid = parseId(providerId);
  if (pid === null) {
    return apiError(400, "Invalid provider id", API_ERROR_CODES.VALIDATION, {
      field: "providerId",
    });
  }

  const sp = req.nextUrl.searchParams;
  const statusParam = sp.get("status");
  const searchParam = sp.get("search")?.trim() ?? null;
  const sortBy = sp.get("sortBy");
  const sortDir = sp.get("sortDir") === "asc" ? "asc" : "desc";

  // status param is a comma-separated list; default excludes archived.
  const requestedStatuses = statusParam
    ? statusParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => VALID_STATUSES.has(s))
    : ["active", "suspended", "blocked"];

  const conditions = [
    eq(provider_phones.org_id, orgId),
    eq(provider_phones.provider_id, pid),
    inArray(provider_phones.status, requestedStatuses),
  ];
  if (searchParam) {
    conditions.push(ilike(provider_phones.phone_number, `%${searchParam}%`));
  }
  const where = and(...conditions);

  const sortKey = (sortBy ?? "created_at") as keyof typeof SORT_COLUMNS;
  const sortColumn = SORT_COLUMNS[sortKey] ?? provider_phones.created_at;
  const orderFn = sortDir === "asc" ? asc : desc;

  const rows = await db
    .select({
      id: provider_phones.id,
      org_id: provider_phones.org_id,
      provider_id: provider_phones.provider_id,
      brand_id: provider_phones.brand_id,
      // Which credential (account) this number is linked to, if any — the
      // account-shaped credentials UI (components/providers/provider-credentials-section.tsx)
      // needs this to mark phones already linked to another account in its
      // numbers picker and to pre-select the Edit dialog's picker.
      credential_id: provider_phones.credential_id,
      phone_number: provider_phones.phone_number,
      country_code: provider_phones.country_code,
      dial_code: provider_phones.dial_code,
      local_number: provider_phones.local_number,
      cost_per_sms: provider_phones.cost_per_sms,
      number_type: provider_phones.number_type,
      status: provider_phones.status,
      archived_at: provider_phones.archived_at,
      created_at: provider_phones.created_at,
      brand: {
        id: brands.id,
        name: brands.name,
        color: brands.color,
        avatar_url: brands.avatar_url,
      },
    })
    .from(provider_phones)
    .leftJoin(brands, eq(provider_phones.brand_id, brands.id))
    .where(where)
    .orderBy(orderFn(sortColumn));

  const data = rows.map((r) => ({
    ...r,
    brand: r.brand && r.brand.id !== null ? r.brand : null,
  }));

  return NextResponse.json({ data });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ providerId: string }> },
) {
  const auth = await requireApiMembership();
  if ("error" in auth) return auth.error;
  const { orgId, role } = auth;

  if (!can(role, "provider_phones.create")) {
    return apiError(403, "Forbidden", API_ERROR_CODES.FORBIDDEN);
  }

  const { providerId } = await params;
  const pid = parseId(providerId);
  if (pid === null) {
    return apiError(400, "Invalid provider id", API_ERROR_CODES.VALIDATION, {
      field: "providerId",
    });
  }

  // Verify provider exists in this org (and isn't archived — adding phones to an
  // archived provider is allowed; archiving doesn't lock the FK).
  const providerRows = await db
    .select({ id: sms_providers.id })
    .from(sms_providers)
    .where(
      and(eq(sms_providers.id, pid), eq(sms_providers.org_id, orgId)),
    )
    .limit(1);
  if (!providerRows[0]) {
    return apiError(404, "Provider not found", API_ERROR_CODES.NOT_FOUND, {
      entity: "provider",
    });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body", API_ERROR_CODES.VALIDATION);
  }

  const parsed = providerPhoneCreateSchema.safeParse(json);
  if (!parsed.success) {
    return apiError(
      400,
      parsed.error.issues[0]?.message ?? "Invalid input",
      API_ERROR_CODES.VALIDATION,
    );
  }

  // Short codes are 5–6 digit numeric codes (already shape-checked by the
  // validator) — no E.164 parsing, geo columns stay NULL. Everything else
  // (10DLC / toll-free) is a phone number normalized via validatePhone.
  let normalized: string;
  let countryCode: string | null = null;
  let dialCode: string | null = null;
  let localNumber: string | null = null;
  if (parsed.data.number_type === "short_code") {
    normalized = parsed.data.phone_number.trim();
  } else {
    const validation = validatePhone(parsed.data.phone_number);
    if (!validation.valid || !validation.normalized) {
      return apiError(
        400,
        validation.error ?? "Invalid phone number",
        API_ERROR_CODES.VALIDATION,
        { field: "phone_number" },
      );
    }
    normalized = validation.normalized;
    countryCode = validation.country_code;
    dialCode = validation.dial_code;
    localNumber = validation.local_number;
  }

  try {
    const [created] = await db
      .insert(provider_phones)
      .values({
        org_id: orgId,
        provider_id: pid,
        brand_id: parsed.data.brand_id ?? null,
        phone_number: normalized,
        country_code: countryCode,
        dial_code: dialCode,
        local_number: localNumber,
        cost_per_sms: String(parsed.data.cost_per_sms),
        number_type: parsed.data.number_type,
        max_sends_per_second: parsed.data.max_sends_per_second ?? null,
        status: "active",
      })
      .returning();
    return NextResponse.json(created, { status: 201 });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return apiError(
        409,
        parsed.data.number_type === "short_code"
          ? "This number already exists in your organization"
          : "This phone number already exists in your organization",
        API_ERROR_CODES.DUPLICATE,
        { field: "phone_number" },
      );
    }
    throw err;
  }
}
