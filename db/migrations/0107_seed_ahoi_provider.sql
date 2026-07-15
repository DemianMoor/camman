-- Seed the Ahoi SMS provider row (idempotent, additive). Number + credential
-- are seeded by scripts/seed-ahoi-number-credential.ts (they carry env secrets).
-- Uses the single-org model: attach to the one organizations row.
INSERT INTO sms_providers (sms_provider_id, org_id, name, supports_api_send, status)
SELECT 'ahoi', o.id, 'Ahoi', true, 'active'
FROM organizations o
ON CONFLICT (sms_provider_id) DO NOTHING;
