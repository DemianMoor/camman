import type { Metadata } from "next";

import { GroupLifecycleTable } from "@/components/reports/group-lifecycle-table";

export const metadata: Metadata = { title: "Group × Lifecycle" };

// /reports/group-lifecycle — how many contacts each contact group can still be
// messaged today, by lifecycle status. Like /reports/audience and
// /reports/lifecycle this is a LITERAL segment, so it takes precedence over the
// sibling [dimension] route and does not join REPORT_DIMENSIONS: its rows are
// contact groups and its columns are lifecycle statuses, neither of which comes
// from the shared per-stage funnel.
export default function GroupLifecycleReportPage() {
  return <GroupLifecycleTable />;
}
