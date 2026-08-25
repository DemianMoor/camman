import type { Metadata } from "next";

import { partnerOrigin } from "@/lib/app-origin";
import {
  ALT_SECRET_HEADER,
  API_CHANGELOG,
  ENDPOINT_METHOD,
  ENDPOINT_PATH,
  EXAMPLE_202_RESPONSE,
  RESPONSE_CODES,
  SANDBOX_STEPS,
  exampleBatch,
  exampleLead,
  minimalLead,
} from "@/lib/intake/api-contract";
import { LEAD_FIELDS, MAX_LEADS_PER_CALL } from "@/lib/intake/fields";

// PUBLIC partner API documentation — no login, no session, no org context.
//
// ⭐ EVERY FIELD, LIMIT AND EXAMPLE ON THIS PAGE IS RENDERED FROM
// lib/intake/fields.ts AND lib/intake/api-contract.ts — the same modules the
// intake endpoint validates against. Nothing here is a hand-written copy, so a
// field added to intake appears on this page with no edit to this file. That is
// asserted by scripts/test-partner-docs-drift.ts, which runs in the build.
//
// ⚠️ THIS PAGE IS PUBLISHED TO ANYONE WITH THE URL. It must never contain:
// table or column names, infrastructure or provider names, org data, per-partner
// values, or anything resembling a credential. Per-key numbers (rate limits,
// payload caps) are described in WORDS and given to each partner directly —
// printing one partner's numbers on a shared page is both wrong for everyone
// else and a disclosure.
//
// ⚠️ Placeholders only. <YOUR_TOKEN> and <YOUR_SECRET> are literal placeholder
// text, never a real value, and the examples use 555-reserved phone numbers and
// example.com addresses.
export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Lead Intake API",
  description:
    "Reference for the lead intake endpoint: authentication, request format, fields, " +
    "response codes, batching, rate limits and sandbox testing.",
};

// The partner-facing origin when one is configured, else a literal placeholder.
// Never the request host — this page is force-static, and a partner reading it
// on one hostname must still be told the hostname their credentials are issued
// against. Build-time value: NEXT_PUBLIC_* is inlined, so changing the env var
// requires a redeploy.
const BASE = partnerOrigin() ?? "https://<your-camman-host>";

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>
  );
}

function Block({ children, label }: { children: string; label?: string }) {
  return (
    <div className="my-4">
      {label && (
        <div className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
          {label}
        </div>
      )}
      <pre className="bg-muted overflow-x-auto rounded-md p-4 text-[13px] leading-relaxed">
        <code className="font-mono">{children}</code>
      </pre>
    </div>
  );
}

function Section({
  id, title, children,
}: {
  id: string; title: string; children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-6 border-t pt-8">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export default function PartnerApiDocsPage() {
  const j = (v: unknown) => JSON.stringify(v, null, 2);

  // The curl example is built from the same derived payload as everything else,
  // so it stays copy-pasteable as the field list changes.
  const curl = [
    `curl -X ${ENDPOINT_METHOD} '${BASE}${ENDPOINT_PATH}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H 'Authorization: Bearer <YOUR_SECRET>' \\`,
    `  -d '${JSON.stringify(minimalLead())}'`,
  ].join("\n");

  const toc = [
    ["auth", "Authentication"], ["endpoint", "Endpoint"], ["request", "Request format"],
    ["curl", "Quick start"], ["fields", "Fields"], ["responses", "Response codes"],
    ["batching", "Batching"], ["limits", "Rate limits"], ["sandbox", "Sandbox"],
    ["changelog", "Changelog"], ["support", "Support"],
  ] as const;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Lead Intake API</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          Leads are submitted via HTTP POST to a partner-specific endpoint. Requests are
          stored and acknowledged synchronously; no downstream processing occurs during
          the call.
        </p>
        <nav className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {toc.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="text-muted-foreground hover:underline">
              {label}
            </a>
          ))}
        </nav>
      </header>

      <div className="space-y-8">
        <Section id="auth" title="Authentication">
          <p className="text-sm leading-relaxed">
            Each partner is issued two credentials.
          </p>
          <div className="my-4 overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs">
                <tr>
                  <th className="p-2 text-left">Value</th>
                  <th className="p-2 text-left">Where it goes</th>
                  <th className="p-2 text-left">Notes</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t">
                  <td className="p-2 font-medium">Token</td>
                  <td className="p-2">In the URL path</td>
                  <td className="p-2">Identifies the partner. Not sufficient on its own.</td>
                </tr>
                <tr className="border-t">
                  <td className="p-2 font-medium">Secret</td>
                  <td className="p-2">
                    In the <Code>Authorization</Code> header
                  </td>
                  <td className="p-2">
                    Authenticates the request. Displayed once; a lost secret is reissued.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <Block>{`Authorization: Bearer <YOUR_SECRET>`}</Block>
          <p className="text-sm leading-relaxed">
            <Code>{`${ALT_SECRET_HEADER}: <YOUR_SECRET>`}</Code> is accepted as an
            alternative.
          </p>
          {/* Not a style preference — the body is stored as received, so a secret
              placed there would be persisted. Keeping it in a header makes it
              structurally absent rather than something we have to redact. */}
          <p className="mt-3 rounded-md border-l-2 border-amber-500 bg-amber-500/5 p-3 text-sm leading-relaxed">
            <strong>Warning:</strong> the secret must not be placed in the request body. The
            body is stored as received, so a secret sent there is persisted rather than
            ignored.
          </p>
        </Section>

        <Section id="endpoint" title="Endpoint">
          <Block>{`${ENDPOINT_METHOD} ${BASE}${ENDPOINT_PATH}
Content-Type: application/json
Authorization: Bearer <YOUR_SECRET>`}</Block>
          <p className="text-sm leading-relaxed">
            Replace <Code>{`<YOUR_TOKEN>`}</Code> and <Code>{`<YOUR_SECRET>`}</Code> with the
            issued credentials. The host is confirmed at onboarding and remains fixed.
          </p>
        </Section>

        <Section id="request" title="Request format">
          <p className="text-sm leading-relaxed">
            The body is a single lead object or an array of lead objects. Only{" "}
            {LEAD_FIELDS.filter((f) => f.required).map((f) => (
              <Code key={f.key}>{f.key}</Code>
            ))}{" "}
            is required; all other fields are optional.
          </p>
          <Block label="Minimal — one lead">{j(minimalLead())}</Block>
          <Block label="Complete — all recognised fields">{j(exampleLead())}</Block>
          <Block label={`Batch — up to ${MAX_LEADS_PER_CALL} leads per request`}>
            {j(exampleBatch())}
          </Block>
          <p className="text-sm leading-relaxed">
            Objects within a batch need not share the same fields. Unrecognised fields are
            retained rather than discarded.
          </p>
        </Section>

        <Section id="curl" title="Quick start">
          <p className="text-sm leading-relaxed">
            A minimal request against a sandbox key. See{" "}
            <a href="#sandbox" className="underline">Sandbox</a> for the full verification
            sequence.
          </p>
          <Block>{curl}</Block>
          <p className="text-sm leading-relaxed">A successful request returns <Code>202</Code>:</p>
          <Block label="202 response">{j(EXAMPLE_202_RESPONSE)}</Block>
          <p className="text-sm leading-relaxed">
            The <Code>leads</Code> array preserves request order, allowing reconciliation by
            index.
          </p>
        </Section>

        <Section id="fields" title="Fields">
          <p className="mb-3 text-sm leading-relaxed">
            Recognised fields, their formats and whether they are required.
          </p>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs">
                <tr>
                  <th className="p-2 text-left">Field</th>
                  <th className="p-2 text-left">Meaning</th>
                  <th className="p-2 text-left">Format</th>
                  <th className="p-2 text-left">Required</th>
                  <th className="p-2 text-left">Example</th>
                </tr>
              </thead>
              <tbody>
                {LEAD_FIELDS.map((f) => (
                  <tr key={f.key} className="border-t align-top" data-field={f.key}>
                    <td className="p-2 font-mono text-[13px]">{f.key}</td>
                    <td className="p-2">{f.label}</td>
                    <td className="p-2">
                      {f.type}
                      {f.allowed && (
                        <div className="text-muted-foreground mt-1 text-xs">
                          {f.allowed.join(" · ")}
                        </div>
                      )}
                    </td>
                    <td className="p-2">
                      {f.required ? (
                        <span className="font-medium">yes</span>
                      ) : (
                        <span className="text-muted-foreground">no</span>
                      )}
                    </td>
                    <td className="p-2 font-mono text-[13px]">{f.example}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="mt-6 mb-2 text-sm font-semibold">Field aliases</h3>
          <p className="text-sm leading-relaxed">
            The following names are accepted as equivalents and require no configuration.
          </p>
          <div className="my-3 overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <tbody>
                {LEAD_FIELDS.filter((f) => f.aliases.length > 0).map((f) => (
                  <tr key={f.key} className="border-t align-top">
                    <td className="w-40 p-2 font-mono text-[13px]">{f.key}</td>
                    <td className="text-muted-foreground p-2 font-mono text-[13px]">
                      {f.aliases.join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm leading-relaxed">
            Payloads using other field names can be mapped server-side on request; see{" "}
            <a href="#support" className="underline">Support</a>.
          </p>

          {LEAD_FIELDS.filter((f) => f.notes).length > 0 && (
            <>
              <h3 className="mt-6 mb-2 text-sm font-semibold">Field details</h3>
              <dl className="space-y-3 text-sm leading-relaxed">
                {LEAD_FIELDS.filter((f) => f.notes).map((f) => (
                  <div key={f.key}>
                    <dt className="font-mono text-[13px] font-medium">{f.key}</dt>
                    <dd className="text-muted-foreground mt-0.5">{f.notes}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </Section>

        <Section id="responses" title="Response codes">
          <p className="mb-3 text-sm leading-relaxed">
            Every status the endpoint returns, with the corresponding resolution.
          </p>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs">
                <tr>
                  <th className="p-2 text-left">Status</th>
                  <th className="p-2 text-left">Meaning</th>
                  <th className="p-2 text-left">Resolution</th>
                  <th className="p-2 text-left">Retry?</th>
                </tr>
              </thead>
              <tbody>
                {RESPONSE_CODES.map((r) => (
                  <tr key={r.status} className="border-t align-top" data-status={r.status}>
                    <td className="p-2 font-mono font-medium">{r.status}</td>
                    <td className="p-2">{r.meaning}</td>
                    <td className="p-2">{r.action}</td>
                    <td className="p-2 whitespace-nowrap">
                      {r.retry === "after-delay" ? "after delay" : r.retry}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3 className="mt-6 mb-2 text-sm font-semibold">Idempotency</h3>
          <p className="text-sm leading-relaxed">
            A phone number resubmitted within the same minute resolves to the existing lead
            and returns its id with <Code>&quot;duplicate&quot;: true</Code>. Retries after a
            timeout cannot create a second lead.
          </p>

          <h3 className="mt-6 mb-2 text-sm font-semibold">Rejected leads</h3>
          <p className="text-sm leading-relaxed">
            A lead with a missing or unparseable phone number returns{" "}
            <Code>&quot;status&quot;: &quot;rejected&quot;</Code> with an{" "}
            <Code>error</Code>. Rejected leads are stored for inspection but not processed
            further.
          </p>
          <p className="mt-3 rounded-md border-l-2 border-amber-500 bg-amber-500/5 p-3 text-sm leading-relaxed">
            <strong>Note:</strong> a response containing rejected leads is still a{" "}
            <Code>202</Code>. Check the per-lead <Code>status</Code> field, not the HTTP
            status alone.
          </p>
        </Section>

        <Section id="batching" title="Batching">
          <p className="text-sm leading-relaxed">
            A request carries a single lead object or an array of up to{" "}
            {MAX_LEADS_PER_CALL} leads.
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed">
            <li>
              Batches are accepted or refused in full. A refused batch stores nothing and
              can be resent unchanged.
            </li>
            <li>
              Individual leads within an accepted batch may still be{" "}
              <Code>rejected</Code>. Other leads in the batch are unaffected.
            </li>
            <li>
              A maximum request size in bytes also applies. The per-key value is issued
              with the credentials; a <Code>413</Code> names the limit exceeded.
            </li>
          </ul>
        </Section>

        <Section id="limits" title="Rate limits">
          <p className="text-sm leading-relaxed">
            Two independent limits apply, counting different units.
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed">
            <li>
              Per second — counts requests. A batch of {MAX_LEADS_PER_CALL} leads is one
              request.
            </li>
            <li>
              Per day — counts leads. A batch of {MAX_LEADS_PER_CALL} leads consumes{" "}
              {MAX_LEADS_PER_CALL}. The daily window resets at midnight US Eastern.
            </li>
          </ul>
          {/* Per-key numbers are deliberately absent: they differ per partner, and
              printing one partner's figures on a shared public page would be both
              wrong for every other reader and a disclosure. */}
          <p className="mt-3 text-sm leading-relaxed">
            Limits are set per partner and issued with the credentials. They are not
            published here.
          </p>
          <p className="mt-3 text-sm leading-relaxed">
            Exceeding a limit returns <Code>429</Code> with a <Code>Retry-After</Code> header
            giving the wait in seconds.
          </p>
          <Block>{`HTTP/1.1 429 Too Many Requests
Retry-After: 37

{ "error": "Rate limit exceeded", "window": "second" }`}</Block>
          <p className="text-sm leading-relaxed">
            A <Code>429</Code> stores nothing and does not consume allowance. Resend the full
            batch after the specified interval.
          </p>
        </Section>

        <Section id="sandbox" title="Sandbox">
          <p className="text-sm leading-relaxed">
            New keys are issued in sandbox mode. Sandbox leads are stored and flagged, are
            never messaged, and are excluded from reporting. Lead ids, duplicate detection
            and validation behave identically to a live key.
          </p>
          <ol className="mt-4 space-y-3 text-sm leading-relaxed">
            {SANDBOX_STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3">
                <span className="bg-muted flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium">
                  {i + 1}
                </span>
                <span>
                  <strong>{s.title}.</strong>{" "}
                  <span className="text-muted-foreground">{s.detail}</span>
                </span>
              </li>
            ))}
          </ol>
        </Section>

        <Section id="changelog" title="Changelog">
          <p className="text-muted-foreground text-sm leading-relaxed">
            Changes to the endpoint contract, most recent first.
          </p>
          <div className="mt-4 space-y-5">
            {API_CHANGELOG.map((e) => (
              <div key={e.date}>
                <div className="font-mono text-sm font-medium">{e.date}</div>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-relaxed">
                  {e.changes.map((c) => (
                    <li key={c} className="text-muted-foreground">{c}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>

        <Section id="support" title="Support">
          <p className="text-sm leading-relaxed">
            For field mapping requests or integration questions, contact your account
            manager.
          </p>
        </Section>
      </div>
    </main>
  );
}
