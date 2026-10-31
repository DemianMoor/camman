import { SYSTEM_PLACEHOLDERS } from "@/lib/intake/passthrough";

// Pure postback URL template helpers (no DB, no server-only).
// Template example: https://p.example/pb?rid={relay_lead_id}&s={status}&c={conversion_id}

export { SYSTEM_PLACEHOLDERS };

export interface PostbackPayload {
  event: "purchase";
  status: string;
  conversion_id: string;
  occurred_at: string;
  currency: string | null;
  payout: string | null;
  fields: Record<string, string>;
}

const PLACEHOLDER_RE = /\{([^{}]*)\}/g;
const MAX_TEMPLATE_LENGTH = 2048;
const SENSITIVE_PARAM_RE = /token|key|secret|sig|auth|pass/i;

export function postbackConfigError(c: {
  template: string;
  passthroughFields: readonly string[];
  includePayout: boolean;
}): string | null {
  const { template, passthroughFields, includePayout } = c;
  if (template.length > MAX_TEMPLATE_LENGTH) {
    return `Postback URL template is longer than ${MAX_TEMPLATE_LENGTH} characters`;
  }
  if (/[{}]/.test(template.replace(PLACEHOLDER_RE, ""))) return "Unbalanced { in template";

  const valid = new Set<string>([...passthroughFields, ...SYSTEM_PLACEHOLDERS]);
  for (const m of template.matchAll(PLACEHOLDER_RE)) {
    if (!valid.has(m[1])) return `Unknown placeholder {${m[1]}}`;
    if (m[1] === "payout" && !includePayout) return "{payout} needs \u201cInclude payout\u201d switched on";
  }

  // A placeholder anywhere up to the end of the authority could change the host at render.
  const schemeEnd = template.indexOf("://");
  if (schemeEnd !== -1) {
    const rest = template.slice(schemeEnd + 3);
    const authLen = rest.search(/[/?#]/);
    const authorityEnd = schemeEnd + 3 + (authLen === -1 ? rest.length : authLen);
    for (const m of template.matchAll(PLACEHOLDER_RE)) {
      if (m.index < authorityEnd) return "Placeholders are only allowed in the path or query";
    }
  }

  let url: URL;
  try {
    url = new URL(template.replace(PLACEHOLDER_RE, "x"));
  } catch {
    return "Postback URL is not a valid URL";
  }
  if (url.protocol !== "https:") return "Postback URL must use https";
  if (url.username || url.password) return "Postback URL must not contain credentials";
  if (url.port !== "" && url.port !== "443") return "Postback URL port must be 443";
  return null;
}

// Lone surrogates make encodeURIComponent throw; replace them with U+FFFD.
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const encodeValue = (v: string) => encodeURIComponent(v.replace(LONE_SURROGATE_RE, "�"));

/** Throws if the rendered URL is not https or its host differs from the template's. */
export function renderPostbackUrl(template: string, p: PostbackPayload, includePayout: boolean): string {
  const rendered = renderRaw(template, p, includePayout);
  const expected = new URL(template.replace(PLACEHOLDER_RE, "x"));
  const actual = new URL(rendered);
  if (actual.protocol !== "https:" || actual.hostname !== expected.hostname) {
    throw new Error("Rendered postback URL does not match the template host");
  }
  return rendered;
}

function renderRaw(template: string, p: PostbackPayload, includePayout: boolean): string {
  return template.replace(PLACEHOLDER_RE, (_, name: string) => {
    let value: string | null | undefined;
    switch (name) {
      case "status": value = p.status; break;
      case "event": value = p.event; break;
      case "conversion_id": value = p.conversion_id; break;
      case "occurred_at": value = p.occurred_at; break;
      case "currency": value = p.currency; break;
      case "payout": value = includePayout ? p.payout : ""; break;
      default: value = Object.prototype.hasOwnProperty.call(p.fields, name) ? p.fields[name] : "";
    }
    return encodeValue(value ?? "");
  });
}

/** Mask sensitive query values to `***`; everything else stays byte-identical. */
export function maskUrl(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return url;
  const head = url.slice(0, q);
  const rest = url.slice(q + 1);
  try {
    new URL(url);
  } catch {
    return `${head}?***`;
  }
  const h = rest.indexOf("#");
  const query = h === -1 ? rest : rest.slice(0, h);
  const frag = h === -1 ? "" : rest.slice(h);
  const masked = query
    .split("&")
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq === -1) return part;
      const rawName = part.slice(0, eq);
      let name = rawName;
      try { name = decodeURIComponent(rawName); } catch { /* keep raw */ }
      return SENSITIVE_PARAM_RE.test(name) ? `${rawName}=***` : part;
    })
    .join("&");
  return `${head}?${masked}${frag}`;
}

export function samplePayload(passthroughFields: readonly string[]): PostbackPayload {
  return {
    event: "purchase",
    status: "approved",
    conversion_id: `test-${crypto.randomUUID()}`,
    occurred_at: new Date().toISOString(),
    currency: "USD",
    payout: "0.00",
    fields: Object.fromEntries(passthroughFields.map((n) => [n, `test_${n}`])),
  };
}
