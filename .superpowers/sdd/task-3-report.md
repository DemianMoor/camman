# Task 3 report
- RED: first run failed "Cannot find module '@/lib/drip/hourly-maintenance'".
- GREEN: all 19 bars passed (H2a-e, H4a-d, H5a-b, H6a-c, H12a-c, H11a-b); "Teardown: 0 row(s) left".
- Brief code used verbatim; no test or module adjustments; fixture's minimal inserts worked on preview unchanged. `deps` kept required.
- eslint clean on 3 files; tsc --noEmit clean.
- Concerns: none.

## Fix round 1
1. prepareHourly order is now: assignFresh -> `able` check (send_paused, halted, lifetime cap, headroom) -> if not able: revertCampaign, room 0, `continue` (closePastHours NOT run) -> closePastHours (OFF only) -> release -> room. Lifetime subquery only when campaign_cap IS NOT NULL (CASE). Header/step comments updated. Tests H6d (no headroom at rollover, then later run) and H6e (send_paused, no clearIneligible call) added.
2. sentBetween(backlogOnly) no longer requires hour_start = H (`hour_fresh IS FALSE` + first_send_at in [H,H+1h)). Test H5c added.
3. Blocked-drop alert text uses formatCampaignDateTime (ET); alertKey stays UTC ISO.
4. `AND campaign_id = ${campaignId}` added to demote/drop UPDATEs and releaseBacklog outer UPDATE; recordSendRefusal doc comment added.
5. makeFixture: teardown defined right after org insert; setup wrapped in try/catch that tears down and rethrows. H2e now compares count, phone set and md5 of full contact-row JSON before/after.

Test command: `node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-drip-hourly-maintenance.ts`
Output: all 24 bars passed (H2a-e, H4a-d, H5a-b, H6a-c, H6d-0/1/2, H6e, H5c, H12a-c, H11a-b); "Teardown: 0 row(s) left"; "All checks passed." eslint and `tsc --noEmit` clean.
