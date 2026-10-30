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

Only `phone` is required. Unknown fields are ignored; see
[Passthrough fields](#passthrough-fields) for extra fields agreed with you.

## Fields

| Field | Meaning | Type | Required | Also accepted as | Example | Notes |
|---|---|---|---|---|---|---|
| `phone` | Mobile Number | phone | **yes** | `mobile`, `mobile_number`, `phone_number`, `cell`, `telephone`, `msisdn` | `+12025550199` | The only required field. E.164 is preferred; US national format is accepted and normalized. A number that cannot be parsed is stored with status 'rejected' rather than discarded. |
| `interest_tag` | Interest Tag | string | no | `tag`, `interest`, `vertical` | `ACA` | May be overridden or defaulted by key configuration. Not a fixed list; new tags are added as configuration. |
| `first_name` | First Name | string | no | `fname`, `firstname`, `given_name` | `Jane` |  |
| `last_name` | Last Name | string | no | `lname`, `lastname`, `surname`, `family_name` | `Doe` |  |
| `email` | Email | email | no | `email_address`, `mail` | `jane@example.com` | Stored lowercased and trimmed. Not a unique key; the phone number is the identity. |
| `address` | Address | string | no | `street`, `address1`, `address_line_1` | `123 Main St` |  |
| `state` | State | string | no | `st`, `region`, `province` | `TX` |  |
| `zip` | ZIP Code | string | no | `zip_code`, `zipcode`, `postal_code`, `postal`, `postcode` | `02134` | US ZIP or ZIP+4. Stored as received. |
| `country` | Country | string | no | `country_code` | `US` |  |
| `gender` | Gender | enum | no | `sex` | `female` | Allowed: `male` · `female` · `other` |
| `dob` | Date of Birth | date | no | `date_of_birth`, `birth_date`, `birthday` | `1985-04-17` | ISO 8601 (YYYY-MM-DD). Omit or send an empty value when unknown. Epoch placeholders such as 1970-01-01 are treated as unknown and discarded. |
| `income_band` | Income | enum | no | `income`, `household_income` | `50-75k` | Allowed: `<25k` · `25-50k` · `50-75k` · `75-100k` · `100-150k` · `150k+` |
| `kids` | Has Children | boolean | no | `children`, `has_kids` | `true` |  |
| `married` | Married | boolean | no | `is_married`, `marital_status` | `false` |  |

If your field names differ from ours, tell us and we map them on our side — you
do not need to change your payload.

## Passthrough fields

Besides the fields above, we can agree a short list of extra field names with you. Values you send in those fields are stored with the lead and handed back to you in sales postbacks (see below). The agreed names are given to you directly.

- Field names are matched case-insensitively.
- Unknown fields are ignored: only the standard fields above and your agreed names are used.
- Up to 10 agreed fields; each name is at most 40 characters (lowercase letters, digits and underscore, starting with a letter).
- Each value is at most 256 characters, and all passthrough values together are at most 2048 bytes.
- A field with a value that does not fit the limits is dropped and the lead is still accepted; the lead's entry in the 202 response then carries a `warnings` array.

```json
{
  "phone": "+12025550199",
  "your_field": "abc-123",
  "another_field": "xyz"
}
```

## Sales postbacks

If agreed, we notify a URL of yours when a lead you sent makes an approved purchase. We make an HTTP GET to your https URL (port 443). Depending on your agreement, a postback is sent for every approved purchase or only the first one per lead.

Your URL is a template. Write any of these in curly braces and we fill them in, together with your agreed passthrough field names (for example {your_field}). Values are URL-encoded; a value we do not have renders empty.

| Placeholder | Value |
|---|---|
| `{status}` | Outcome of the sale, for example approved. |
| `{event}` | Event type of the sale. |
| `{conversion_id}` | Unique id of this sale. Use it to de-duplicate. |
| `{occurred_at}` | When the sale happened, UTC, ISO 8601. |
| `{currency}` | Currency code of the amount. |
| `{payout}` | Amount for the sale. Sent only if enabled for your account. |

Example URL:

```
https://example.com/postback?ref={your_field}&status={status}&conversion_id={conversion_id}
```

### Delivery and retries

Any 2xx response means delivered. A timeout, a 5xx, 408 or 429 is retried; other responses are not. Redirects are not followed. Retries happen after:

1. 1 min
2. 5 min
3. 30 min
4. 2 h
5. 6 h
6. 24 h

After the last retry we stop.

> **Note:** Delivery is at least once: the same sale can reach you more than once. De-duplicate on {conversion_id}.

## Responses

| Status | Meaning | What to do |
|---|---|---|
| `202` | Accepted and stored. | Nothing. |
| `400` | Body was not valid JSON. | Fix the request; do not retry unchanged. |
| `401` | Token or secret wrong. | Check credentials. Repeated failures alert us. |
| `403` | Your key is disabled. | Contact us. |
| `413` | Payload or batch too large. | Split into smaller batches. The limit is in the response body. If it names `rate_per_day`, the batch is bigger than your whole daily allowance — splitting will not help; contact us. |
| `429` | Rate limit hit. | Wait and retry — see `Retry-After`. Nothing was stored, so resend the whole batch. If the body says `"window": "day"`, today's allowance is used up: this is **final for today** and `Retry-After` points at midnight US Eastern. |
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
A lead entry may also carry a `warnings` array of strings. It appears only when part of that lead was dropped (for example a passthrough field whose value was too long); the lead itself is still accepted.

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

**The daily limit is final for the day.** Once it is reached, every further lead
that day is refused with `429` and `"window": "day"`, and `Retry-After` counts
down to midnight US Eastern. Retrying later the same day will not succeed;
resend the next day. Leads in a refused batch are not stored.

## Sandbox

Every new key starts in **sandbox**. Sandbox leads are stored and clearly
flagged, but are never messaged and are excluded from reporting. Use it to prove
your integration end to end: you will see real ids, real duplicate detection and
real validation errors, with no possibility of a message going out.

> **Note:** Phone validation in sandbox checks format only: a well-formed number is accepted even if its area code is not a real one, so test records such as +1 555 555 0100 work. Length and structure are still enforced, and a malformed number is still rejected. A live key requires a real, assigned number — switch to genuine test numbers before activation.

When you are ready, we switch the key live. **Nothing about your request
changes** — same URL, same credentials, same payload.

## Getting started

1. We send you a token and a secret.
2. Post one lead. You should get `202` with `"sandbox": true`.
3. Post the same lead again — you should get `"duplicate": true`.
4. Post one with no phone — you should get `"status": "rejected"`.
5. Tell us, and we switch you live.
