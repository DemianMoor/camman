# Sending leads to CamMan

_Generated from `lib/intake/fields.ts` by `scripts/generate-partner-docs.ts` — do not edit by hand._

You post leads to a URL we give you. We store them and reply immediately; nothing
else happens on the call, so it is fast and safe to retry.

## Endpoint

```
POST https://<your-camman-host>/api/intake/leads/<YOUR_TOKEN>
Content-Type: application/json
Authorization: Bearer <YOUR_SECRET>
```

You receive **two** values from us. Both are secret:

| Value | Where it goes | Notes |
|---|---|---|
| **Token** | in the URL path | Identifies you. Not a password on its own. |
| **Secret** | in the `Authorization` header | Proves it is you. Shown to us once; if you lose it we must issue a new one. |

`X-Partner-Secret: <YOUR_SECRET>` works instead of `Authorization` if that is
easier. **Never put the secret in the JSON body** — we do not read it there, and
the body is stored as-is.

## Body

A single lead object, or an array of up to **500** of them.

```json
{ "phone": "+12025550199", "first_name": "Jane", "interest_tag": "ACA" }
```

```json
[
  { "phone": "+12025550199", "first_name": "Jane" },
  { "phone": "+12025550111", "first_name": "John" }
]
```

Only `phone` is required. Send whatever else you have — **unknown fields are
kept**, not discarded, so nothing is lost if you send more than the list below.

## Fields

| Field | Meaning | Type | Required | Also accepted as | Example | Notes |
|---|---|---|---|---|---|---|
| `phone` | Mobile Number | phone | **yes** | `mobile`, `mobile_number`, `phone_number`, `cell`, `telephone`, `msisdn` | `+12025550199` | The only required field. E.164 preferred; US national format is accepted and normalized. A lead whose number cannot be parsed is still STORED, with status 'rejected' — it is never silently discarded. |
| `interest_tag` | Interest Tag | string | no | `tag`, `interest`, `vertical` | `ACA` | May be overridden or defaulted by your key's configuration. Deliberately not a fixed list — new tags are configuration, not a code change. |
| `first_name` | First Name | string | no | `fname`, `firstname`, `given_name` | `Jane` |  |
| `last_name` | Last Name | string | no | `lname`, `lastname`, `surname`, `family_name` | `Doe` |  |
| `email` | Email | email | no | `email_address`, `mail` | `jane@example.com` | Stored lowercased and trimmed. Not a unique key — the phone is the identity. |
| `address` | Address | string | no | `street`, `address1`, `address_line_1` | `123 Main St` |  |
| `state` | State | string | no | `st`, `region`, `province` | `TX` |  |
| `country` | Country | string | no | `country_code` | `US` |  |
| `gender` | Gender | enum | no | `sex` | `female` | Allowed: `male` · `female` · `other` |
| `dob` | Date of Birth | date | no | `date_of_birth`, `birth_date`, `birthday` | `1985-04-17` | ISO 8601 (YYYY-MM-DD). ⚠️ Send an EMPTY VALUE for unknown, never 1970-01-01 — an epoch placeholder is treated as unknown and discarded, because storing it would manufacture a false age cohort. |
| `income_band` | Income | enum | no | `income`, `household_income` | `50-75k` | Allowed: `<25k` · `25-50k` · `50-75k` · `75-100k` · `100-150k` · `150k+` |
| `kids` | Has Children | boolean | no | `children`, `has_kids` | `true` |  |
| `married` | Married | boolean | no | `is_married`, `marital_status` | `false` |  |

If your field names differ from ours, tell us and we map them on our side — you
do not need to change your payload.

## Responses

| Status | Meaning | What to do |
|---|---|---|
| `202` | Accepted and stored. | Nothing. |
| `400` | Body was not valid JSON. | Fix the request; do not retry unchanged. |
| `401` | Token or secret wrong. | Check credentials. Repeated failures alert us. |
| `403` | Your key is disabled. | Contact us. |
| `413` | Payload or batch too large. | Split into smaller batches. The limit is in the response body. |
| `429` | Rate limit hit. | Wait and retry — see `Retry-After`. Nothing was stored, so resend the whole batch. |
| `500` | We failed to store it. | **Retry.** We would rather have it twice than not at all. |

A `202` body looks like:

```json
{
  "accepted": 2,
  "duplicates": 0,
  "rejected": 0,
  "sandbox": true,
  "leads": [
    { "id": "…", "status": "received", "duplicate": false },
    { "id": "…", "status": "received", "duplicate": false }
  ]
}
```

`leads` is in the same order you sent them, so you can reconcile by index.

### Duplicates are safe

The same phone number sent twice within the same minute resolves to the **same
stored lead**, and you get its id back with `"duplicate": true`. So retrying
after a timeout cannot create a second lead — retry freely.

### Rejected leads are still stored

A lead with a missing or unparseable phone comes back as
`"status": "rejected"` with an `error`. We keep it rather than dropping it, so
we can show you exactly what arrived when an integration is misbehaving. It is
not processed further.

## Rate limits

Two separate limits, and they count different things:

- **Per second** — counts **requests**. A batch of 500 is one request.
- **Per day** — counts **leads**. A batch of 500 costs 500. Resets at midnight
  US Eastern.

A `429` stores nothing at all, and does **not** consume your daily budget — so
being rate-limited never eats into what you can send later that day.

## Sandbox

Every new key starts in **sandbox**. Sandbox leads are stored and clearly
flagged, but are never messaged and are excluded from reporting. Use it to prove
your integration end to end: you will see real ids, real duplicate detection and
real validation errors, with no possibility of a message going out.

When you are ready, we switch the key live. **Nothing about your request
changes** — same URL, same credentials, same payload.

## Getting started

1. We send you a token and a secret.
2. Post one lead. You should get `202` with `"sandbox": true`.
3. Post the same lead again — you should get `"duplicate": true`.
4. Post one with no phone — you should get `"status": "rejected"`.
5. Tell us, and we switch you live.
