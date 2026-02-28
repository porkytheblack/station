type Status = "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped";

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`status-badge status-badge--${status}`}>
      <span className="status-badge-dot" />
      {status}
    </span>
  );
}
