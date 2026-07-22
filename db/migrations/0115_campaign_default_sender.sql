-- Campaign-level default send-from number. Prefill convenience only: when a new
-- stage is created it inherits this as its provider_phone_id (operator can
-- override). Send-time resolution stays stage-only. Nullable; ON DELETE SET NULL
-- so archiving/removing a phone doesn't block campaign edits. Additive +
-- backward-compatible — existing rows default to NULL (no default sender).
ALTER TABLE "campaigns"
  ADD COLUMN "default_provider_phone_id" integer
  REFERENCES "provider_phones"("id") ON DELETE SET NULL;
