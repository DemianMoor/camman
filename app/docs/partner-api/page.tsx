import type { Metadata } from "next";

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
  title: "Partner API — sending leads",
  description:
    "How to send leads to us: authentication, request shape, fields, response codes, " +
    "batching, rate limits and sandbox testing.",
};

const BASE = "https://<your-camman-host>";

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
    ["auth", "Authentication"], ["endpoint", "Endpoint"], ["request", "Example request"],
    ["curl", "Copy-paste curl"], ["fields", "Fields"], ["responses", "Response codes"],
    ["batching", "Batching"], ["limits", "Rate limits"], ["sandbox", "Sandbox"],
    ["changelog", "Changelog"],
  ] as const;

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Partner API — sending leads</h1>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
          You post leads to a URL we give you. We store them and reply immediately;
          nothing else happens during the call, so it is fast and safe to retry.
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
            You receive <strong>two</strong> values from us. Both are secret.
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
                  <td className="p-2">Identifies you. Not a password on its own.</td>
                </tr>
                <tr className="border-t">
                  <td className="p-2 font-medium">Secret</td>
                  <td className="p-2">
                    In the <Code>Authorization</Code> header
                  </td>
                  <td className="p-2">
                    Proves it is you. Shown once — if it is lost we issue a new one.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <Block>{`Authorization: Bearer <YOUR_SECRET>`}</Block>
          <p className="text-sm leading-relaxed">
            <Code>{`${ALT_SECRET_HEADER}: <YOUR_SECRET>`}</Code> works instead, if that is
            easier for your HTTP client.
          </p>
          {/* Not a style preference — the body is stored as received, so a secret
              placed there would be persisted. Keeping it in a header makes it
              structurally absent rather than something we have to redact. */}
          <p className="mt-3 rounded-md border-l-2 border-amber-500 bg-amber-500/5 p-3 text-sm leading-relaxed">
            <strong>Never put the secret in the JSON body.</strong> We do not read it there,
            and the body is stored as received — so a secret sent in the body would be
            persisted rather than ignored.
          </p>
        </Section>

        <Section id="endpoint" title="Endpoint">
          <Block>{`${ENDPOINT_METHOD} ${BASE}${ENDPOINT_PATH}
Content-Type: application/json
Authorization: Bearer <YOUR_SECRET>`}</Block>
          <p className="text-sm leading-relaxed">
            Replace <Code>{`<YOUR_TOKEN>`}</Code> and <Code>{`<YOUR_SECRET>`}</Code> with the
            values we send you. We will also confirm the exact host — it does not change
            once you are set up.
          </p>
        </Section>

        <Section id="request" title="Example request">
          <p className="text-sm leading-relaxed">
            The body is either a single lead object or an array of them. Only{" "}
            {LEAD_FIELDS.filter((f) => f.required).map((f) => (
              <Code key={f.key}>{f.key}</Code>
            ))}{" "}
            is required — send whatever else you have.
          </p>
          <Block label="Minimal — one lead">{j(minimalLead())}</Block>
          <Block label="Full — one lead, every field we recognise">{j(exampleLead())}</Block>
          <Block label={`Batch — up to ${MAX_LEADS_PER_CALL} leads per call`}>
            {j(exampleBatch())}
          </Block>
          <p className="text-sm leading-relaxed">
            Rows in a batch do not have to look alike — send whichever fields you hold for
            each lead. <strong>Unknown fields are kept, not discarded</strong>, so nothing is
            lost if you send more than the list below.
          </p>
        </Section>

        <Section id="curl" title="Copy-paste curl">
          <Block>{curl}</Block>
          <p className="text-sm leading-relaxed">
            Run this against your sandbox key first — see <a href="#sandbox" className="underline">Sandbox</a>.
            A successful call returns <Code>202</Code>:
          </p>
          <Block label="202 response">{j(EXAMPLE_202_RESPONSE)}</Block>
          <p className="text-sm leading-relaxed">
            <Code>leads</Code> comes back in the same order you sent them, so you can
            reconcile by index.
          </p>
        </Section>

        <Section id="fields" title="Fields">
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

          <h3 className="mt-6 mb-2 text-sm font-semibold">Alternative names we accept</h3>
          <p className="text-sm leading-relaxed">
            If your payload already uses one of these names, it works as-is — no mapping
            needed.
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
            If your names differ from all of these, tell us and we map them on our side —
            you do not need to change your payload.
          </p>

          {LEAD_FIELDS.filter((f) => f.notes).length > 0 && (
            <>
              <h3 className="mt-6 mb-2 text-sm font-semibold">Notes on specific fields</h3>
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
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs">
                <tr>
                  <th className="p-2 text-left">Status</th>
                  <th className="p-2 text-left">Meaning</th>
                  <th className="p-2 text-left">What you should do</th>
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

          <h3 className="mt-6 mb-2 text-sm font-semibold">Duplicates are safe</h3>
          <p className="text-sm leading-relaxed">
            The same phone number sent twice within the same minute resolves to the{" "}
            <strong>same stored lead</strong>, and you get its id back with{" "}
            <Code>&quot;duplicate&quot;: true</Code>. Retrying after a timeout therefore
            cannot create a second lead — retry freely.
          </p>

          <h3 className="mt-6 mb-2 text-sm font-semibold">Rejected leads are still stored</h3>
          <p className="text-sm leading-relaxed">
            A lead with a missing or unparseable phone number comes back as{" "}
            <Code>&quot;status&quot;: &quot;rejected&quot;</Code> with an{" "}
            <Code>error</Code>. We keep it rather than dropping it, so we can show you
            exactly what arrived when an integration misbehaves. It is not processed
            further. A <Code>202</Code> containing rejected leads is still a{" "}
            <Code>202</Code> — check the per-lead <Code>status</Code>, not only the HTTP
            code.
          </p>
        </Section>

        <Section id="batching" title="Batching">
          <p className="text-sm leading-relaxed">
            Send a single object, or an array of up to{" "}
            <strong>{MAX_LEADS_PER_CALL}</strong> leads in one call.
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed">
            <li>
              A batch is <strong>all or nothing</strong>. If it is refused — too large, or
              over a limit — nothing from it is stored, so you can resend the whole batch
              without working out which leads landed.
            </li>
            <li>
              Individual leads inside an accepted batch can still come back{" "}
              <Code>rejected</Code> (for example, an unparseable phone). That does not
              affect the others.
            </li>
            <li>
              There is also a maximum request size in bytes. It is generous for
              {" "}{MAX_LEADS_PER_CALL} normal leads; we tell you your exact figure when we
              issue your key, and a <Code>413</Code> names the limit it hit.
            </li>
          </ul>
        </Section>

        <Section id="limits" title="Rate limits">
          <p className="text-sm leading-relaxed">
            Two separate limits, counting different things:
          </p>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed">
            <li>
              <strong>Per second</strong> — counts <strong>requests</strong>. A batch of{" "}
              {MAX_LEADS_PER_CALL} is one request.
            </li>
            <li>
              <strong>Per day</strong> — counts <strong>leads</strong>. A batch of{" "}
              {MAX_LEADS_PER_CALL} costs {MAX_LEADS_PER_CALL}. The day resets at midnight
              US Eastern.
            </li>
          </ul>
          {/* Per-key numbers are deliberately absent: they differ per partner, and
              printing one partner's figures on a shared public page would be both
              wrong for every other reader and a disclosure. */}
          <p className="mt-3 text-sm leading-relaxed">
            <strong>Your specific numbers are given to you directly</strong> when we issue
            your key — they are not published here, because they differ per partner.
          </p>
          <p className="mt-3 text-sm leading-relaxed">
            When you exceed a limit you get <Code>429</Code> with a{" "}
            <Code>Retry-After</Code> header giving the number of seconds to wait. Honour it
            rather than retrying immediately.
          </p>
          <Block>{`HTTP/1.1 429 Too Many Requests
Retry-After: 37

{ "error": "Rate limit exceeded", "window": "second" }`}</Block>
          <p className="text-sm leading-relaxed">
            A <Code>429</Code> stores nothing and <strong>does not consume any allowance</strong>,
            so being throttled never reduces what you can send later that day. Resend the
            whole batch after waiting.
          </p>
        </Section>

        <Section id="sandbox" title="Sandbox">
          <p className="text-sm leading-relaxed">
            Every new key starts in <strong>sandbox</strong>. Sandbox leads are stored and
            clearly flagged, but are never messaged and are excluded from reporting. You can
            prove your integration end to end — real ids, real duplicate detection, real
            validation errors — with no possibility of a message going out.
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
            Changes to what this endpoint accepts. Newest first.
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
      </div>

      <footer className="text-muted-foreground mt-10 border-t pt-6 text-xs leading-relaxed">
        Questions, a field we do not list, or different names in your payload — talk to us
        and we will map it on our side.
      </footer>
    </main>
  );
}
