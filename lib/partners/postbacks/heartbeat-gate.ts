// Pure, no imports: the drip-monitors watchdog's decision for the partner-postbacks
// heartbeat. A stale heartbeat pages only once postbacks are live — the delivery
// kill switch is on, or some key has postback_enabled — so a job that has never
// run before go-live does not page anyone.
export function shouldAlertPostbackHeartbeat(s: {
  stale: boolean;
  deliveryEnabled: boolean;
  anyKeyEnabled: boolean;
}): boolean {
  return s.stale && (s.deliveryEnabled || s.anyKeyEnabled);
}
