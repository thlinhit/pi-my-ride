export type ReviewState = "guardian-running" | "approval-required" | "revision-requested" | "approved" | "blocked";

export interface ReviewStatus {
  readonly toolCallId: string;
  readonly state: ReviewState;
  readonly label: string;
  readonly source?: string;
  readonly reviewer?: string;
  readonly detail?: string;
}

export function isTerminal(state: ReviewState): boolean {
  return state === "approved" || state === "blocked";
}

function rowPrefix(state: ReviewState): string {
  switch (state) {
    case "guardian-running": return "◌ guardian running";
    case "approval-required": return "? approval required";
    case "revision-requested": return "↻ revision requested";
    case "approved": return "✓ approved";
    case "blocked": return "✗ blocked";
  }
}

export function formatStatusLines(status: ReviewStatus): string[] {
  const first = `${rowPrefix(status.state)} · ${status.label}${status.state === "guardian-running" && status.reviewer ? ` · ${status.reviewer}` : ""}`;
  const lines = [first];
  if (status.source) lines.push(`source: ${status.source}`);
  if (status.detail) lines.push(status.detail);
  return lines;
}

export function widgetLines(status: ReviewStatus): string[] {
  const state = status.state === "revision-requested" || status.state === "blocked" ? "blocked" : status.state === "approved" ? "approved" : "reviewing";
  return [`auto-approval: ${state} [${status.label}]`, ...(status.detail === "Cancelled" ? [status.detail] : [])];
}
