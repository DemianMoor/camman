// Pure (no DB imports) so the client stage editor can share the server's rule.

/**
 * PURE. When a stage's message shape locks (spec R4). A REGULAR stage locks
 * once it is materialized — its bodies are already rendered, so a new format
 * would no longer change the messages (owner, P4). A DRIP stage materializes
 * nothing up front; it locks at its first sent row, like its creative (A9).
 */
export function stageFormatLocked(i: { isDrip: boolean; materialized: boolean; hasSent: boolean }): boolean {
  return i.isDrip ? i.hasSent : i.materialized;
}
