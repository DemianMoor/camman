-- Reports rollup layer (Phase 1). See REPORTS-ROLLUP-RECON.md.
-- Two pre-aggregated hourly-bucket fact tables feeding five reports, plus two
-- durable per-send snapshot columns. All time bucketing is by the SEND hour in
-- America/New_York (ET). EPC / profit / rates are derived at READ time, never
-- stored. Read-time reports (the five views) and the maintenance cron land in a
-- later change; this migration is the data layer only.

-- ---------------------------------------------------------------------------
-- 1. Durable per-send snapshot columns (Open Question #5).
--    Stamped at materialization (lib/sends/kickoff.ts) so per-number attribution
--    and cost survive later edits to the stage's provider_phone_id / rate.
--    Nullable, no default ⇒ metadata-only ALTER (no rewrite of the ~1M-row
--    table). Existing rows stay NULL; the rollup COALESCEs to the stage's live
--    provider_phone_id / provider_phones.cost_per_sms for pre-snapshot history.
-- ---------------------------------------------------------------------------
ALTER TABLE "stage_sends" ADD COLUMN "provider_phone_id" integer;
ALTER TABLE "stage_sends" ADD COLUMN "cost_per_sms" numeric(12, 4);

ALTER TABLE "stage_sends"
  ADD CONSTRAINT "stage_sends_provider_phone_id_provider_phones_id_fk"
  FOREIGN KEY ("provider_phone_id") REFERENCES "provider_phones"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- 2. Fact A — report_stage_hour: one row per (org, stage, ET send-hour).
--    Feeds reports #1 (number), #2 (offer), #3 (sequence message), #4 (hourly).
--    The sending number is functionally determined by the stage (0 stages span
--    >1 phone), so all four dimensions are denormalized here at zero extra row
--    cost (~302 rows all-time). `settled` freezes buckets past the 14-day
--    trickle horizon. Grand totals ALWAYS come from this table, never from
--    summing report_group_hour (which fans out — see below).
-- ---------------------------------------------------------------------------
CREATE TABLE "report_stage_hour" (
  "org_id" uuid NOT NULL,
  "stage_id" integer NOT NULL,
  "campaign_id" integer NOT NULL,
  "bucket_start_utc" timestamp with time zone NOT NULL,
  "bucket_date_et" date NOT NULL,
  "bucket_hour_et" smallint NOT NULL,
  -- denormalized dimension keys (resolved from the send/stage/campaign at build):
  "offer_id" integer,
  "brand_id" integer,
  "provider_credential_id" integer,
  "provider_phone_id" integer,
  "sms_provider_id" integer,
  "stage_number" integer,
  "behavioral_tier" smallint,
  "funnel_stage" text,
  "creative_id" integer,
  -- additive counters:
  "sent_count" integer DEFAULT 0 NOT NULL,
  "opt_out_count" integer DEFAULT 0 NOT NULL,
  "click_count" integer DEFAULT 0 NOT NULL,
  "offer_redirect_count" integer DEFAULT 0 NOT NULL,
  "sales_count" integer DEFAULT 0 NOT NULL,
  "revenue" numeric(12, 4) DEFAULT 0 NOT NULL,
  "cost" numeric(12, 4) DEFAULT 0 NOT NULL,
  -- housekeeping:
  "settled" boolean DEFAULT false NOT NULL,
  "refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "report_stage_hour_pk" PRIMARY KEY ("org_id", "stage_id", "bucket_start_utc")
);

-- Identity FKs only (cascade cleanup on hard delete). Denormalized dimension
-- keys (offer_id, provider_phone_id, …) are snapshots — deliberately NOT FK'd,
-- same as stage_sends.carrier_norm and the offer-group matview.
ALTER TABLE "report_stage_hour"
  ADD CONSTRAINT "report_stage_hour_org_id_fk" FOREIGN KEY ("org_id")
  REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "report_stage_hour"
  ADD CONSTRAINT "report_stage_hour_stage_id_fk" FOREIGN KEY ("stage_id")
  REFERENCES "campaign_stages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "report_stage_hour"
  ADD CONSTRAINT "report_stage_hour_campaign_id_fk" FOREIGN KEY ("campaign_id")
  REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE INDEX "report_stage_hour_org_date_idx" ON "report_stage_hour" ("org_id", "bucket_date_et");
CREATE INDEX "report_stage_hour_org_offer_idx" ON "report_stage_hour" ("org_id", "offer_id", "bucket_start_utc");
CREATE INDEX "report_stage_hour_org_phone_idx" ON "report_stage_hour" ("org_id", "provider_phone_id", "bucket_start_utc");
-- Rolling-window maintenance recomputes WHERE bucket_start_utc >= now()-14d and
-- settles the rest; this partial index keeps the settle sweep cheap at scale.
CREATE INDEX "report_stage_hour_unsettled_idx" ON "report_stage_hour" ("bucket_start_utc") WHERE "settled" = false;

-- ---------------------------------------------------------------------------
-- 3. Fact B — report_group_hour: one row per (org, contact_group, stage, hour).
--    Feeds report #5 (by group). Fans out over the many-to-many
--    contact_contact_groups junction: a send to a contact in N groups is counted
--    in all N rows (avg 1.34, max 6). Per-group numbers are truthful PER GROUP;
--    summing groups OVERCOUNTS the true total by design (matches
--    offer_group_report_mv). ~2,024 rows all-time.
-- ---------------------------------------------------------------------------
CREATE TABLE "report_group_hour" (
  "org_id" uuid NOT NULL,
  "contact_group_id" integer NOT NULL,
  "stage_id" integer NOT NULL,
  "campaign_id" integer NOT NULL,
  "bucket_start_utc" timestamp with time zone NOT NULL,
  "bucket_date_et" date NOT NULL,
  "bucket_hour_et" smallint NOT NULL,
  "offer_id" integer,
  "brand_id" integer,
  "provider_credential_id" integer,
  "provider_phone_id" integer,
  "sms_provider_id" integer,
  "stage_number" integer,
  "behavioral_tier" smallint,
  "funnel_stage" text,
  "creative_id" integer,
  "sent_count" integer DEFAULT 0 NOT NULL,
  "opt_out_count" integer DEFAULT 0 NOT NULL,
  "click_count" integer DEFAULT 0 NOT NULL,
  "offer_redirect_count" integer DEFAULT 0 NOT NULL,
  "sales_count" integer DEFAULT 0 NOT NULL,
  "revenue" numeric(12, 4) DEFAULT 0 NOT NULL,
  "cost" numeric(12, 4) DEFAULT 0 NOT NULL,
  "settled" boolean DEFAULT false NOT NULL,
  "refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "report_group_hour_pk" PRIMARY KEY ("org_id", "contact_group_id", "stage_id", "bucket_start_utc")
);

ALTER TABLE "report_group_hour"
  ADD CONSTRAINT "report_group_hour_org_id_fk" FOREIGN KEY ("org_id")
  REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "report_group_hour"
  ADD CONSTRAINT "report_group_hour_group_id_fk" FOREIGN KEY ("contact_group_id")
  REFERENCES "contact_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "report_group_hour"
  ADD CONSTRAINT "report_group_hour_stage_id_fk" FOREIGN KEY ("stage_id")
  REFERENCES "campaign_stages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "report_group_hour"
  ADD CONSTRAINT "report_group_hour_campaign_id_fk" FOREIGN KEY ("campaign_id")
  REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE INDEX "report_group_hour_org_group_idx" ON "report_group_hour" ("org_id", "contact_group_id", "bucket_start_utc");
CREATE INDEX "report_group_hour_org_date_idx" ON "report_group_hour" ("org_id", "bucket_date_et");
CREATE INDEX "report_group_hour_unsettled_idx" ON "report_group_hour" ("bucket_start_utc") WHERE "settled" = false;
