import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { db } from "@/db/client";
import { audit_log, org_members } from "@/db/schema";
import { notifyTelegram } from "@/lib/alerts/telegram";
import { writeAuditLog } from "@/lib/audit";

// Login telemetry: stamp org_members.last_login_at / last_login_ip, write the
// auth.login audit row, and raise auth.login_new_ip the first time an actor
// signs in from an address we have not seen before.
//
// ⚠️ The "new IP" signal is a PROMPT FOR A HUMAN, never a control. The address
// comes from x-forwarded-for, whose left-hand entries are client-controlled
// (see lib/audit.ts). Anyone able to spoof it can equally suppress the alert,
// so nothing may gate on it. It exists so an Owner notices an unexpected
// sign-in, which is worth having even though it is not tamper-proof.

export async function recordLogin(opts: {
  orgId: string;
  userId: string;
  email: string | null;
  method: "google" | "password";
  ip?: string | null;
  userAgent?: string | null;
}): Promise<{ newIp: boolean }> {
  const { orgId, userId, email, method, ip } = opts;

  // Has this actor ever logged in from this ip before? Uses
  // audit_log_org_actor_created_idx. Only meaningful when we actually have an
  // address — a null ip must never read as "new", or every login behind a
  // stripped header would alert.
  let newIp = false;
  if (ip) {
    const seen = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(audit_log)
      .where(
        and(
          eq(audit_log.org_id, orgId),
          eq(audit_log.actor_user_id, userId),
          eq(audit_log.action, "auth.login"),
          eq(audit_log.ip, ip),
        ),
      );
    newIp = (seen[0]?.n ?? 0) === 0;
  }

  await db
    .update(org_members)
    .set({ last_login_at: new Date(), last_login_ip: ip ?? null })
    .where(
      and(eq(org_members.org_id, orgId), eq(org_members.user_id, userId)),
    );

  // Order matters: the auth.login row must be written AFTER the "seen before"
  // probe, or the probe would always find its own row and never report a new
  // IP.
  await writeAuditLog({
    orgId,
    actorUserId: userId,
    action: "auth.login",
    entityType: "org_member",
    entityId: userId,
    summary: `${email ?? userId} signed in via ${method}`,
    metadata: { method },
    ip,
    userAgent: opts.userAgent,
  });

  if (newIp) {
    await writeAuditLog({
      orgId,
      actorUserId: userId,
      action: "auth.login_new_ip",
      entityType: "org_member",
      entityId: userId,
      summary: `${email ?? userId} signed in from a new IP address`,
      metadata: { method, ip },
      ip,
      userAgent: opts.userAgent,
    });

    // 869et3vm1 Phase 4: alert, not just record. Phase 2 wrote the audit row
    // and stopped there, which meant the one event most worth interrupting
    // someone about was only discoverable by going and looking for it.
    //
    // ⚠️ THIS IS A PROMPT FOR A HUMAN, NOT A CONTROL. The address comes from
    // x-forwarded-for, whose left-hand entries are client-controlled, so anyone
    // able to spoof it can equally suppress the alert. Nothing gates on it.
    //
    // Fired AFTER the audit write, and its result deliberately ignored: a
    // Telegram outage must never cost us the durable record.
    await notifyTelegram(
      [
        "🔐 Sign-in from a new IP",
        `${email ?? userId} · via ${method}`,
        `IP: ${ip ?? "unknown"}`,
        opts.userAgent ? `UA: ${opts.userAgent.slice(0, 120)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return { newIp };
}

/** Most recent successful login for each member, for the Users screen. */
export async function lastLoginFor(
  orgId: string,
  userId: string,
): Promise<{ at: Date; ip: string | null } | null> {
  const rows = await db
    .select({ at: audit_log.created_at, ip: audit_log.ip })
    .from(audit_log)
    .where(
      and(
        eq(audit_log.org_id, orgId),
        eq(audit_log.actor_user_id, userId),
        eq(audit_log.action, "auth.login"),
      ),
    )
    .orderBy(desc(audit_log.created_at))
    .limit(1);
  return rows[0] ?? null;
}
