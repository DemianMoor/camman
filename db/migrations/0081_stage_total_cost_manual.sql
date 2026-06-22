-- Auto-derived stage Total Cost from the provider phone's cost-per-SMS.
--
-- total_cost is now, by default, cost_per_sms × (sms_count + opt_out_count),
-- recomputed on every write that changes those inputs (manual results save,
-- opt-out poller, provider-phone change). `total_cost_manual` is the escape
-- hatch: when true, the value is an operator override or a CSV-imported
-- provider cost and the auto formula leaves it alone. See
-- lib/stages/total-cost.ts.
--
-- Default FALSE so new stages are auto. Existing stages that already carry a
-- non-zero total_cost got it from a CSV import or a hand-entered figure — mark
-- those as manual so the first recompute doesn't clobber a real cost.

ALTER TABLE campaign_stages
  ADD COLUMN total_cost_manual boolean NOT NULL DEFAULT false;

UPDATE campaign_stages
  SET total_cost_manual = true
  WHERE total_cost <> 0;
