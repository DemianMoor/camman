// Pure, no imports: the go-live predicate for partner-postback alerts. Postbacks
// are "live" once the delivery kill switch is on, or some key has
// postback_enabled. Before that nothing pages — a job that has never run, or an
// enqueue with nothing to queue, is not an incident.
export function postbacksLive(s: { deliveryEnabled: boolean; anyKeyEnabled: boolean }): boolean {
  return s.deliveryEnabled || s.anyKeyEnabled;
}

// The drip-monitors watchdog's decision for the partner-postbacks heartbeat: a
// stale heartbeat pages only once postbacks are live.
export function shouldAlertPostbackHeartbeat(s: {
  stale: boolean;
  deliveryEnabled: boolean;
  anyKeyEnabled: boolean;
}): boolean {
  return s.stale && postbacksLive(s);
}
