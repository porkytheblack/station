"use client";

const statusItems = [
  "Job queue: nominal",
  "Scheduler: transmitting",
  "Retry engine: active",
  "Cron parser: locked",
  "Broadcast DAG: resolved",
  "SQLite WAL: synced",
];

export function UptimeTicker() {
  return (
    <div className="uptime-strip">
      <span className="uptime-label">Live status</span>
      <div className="uptime-ticker-wrap">
        <div className="uptime-ticker">
          {statusItems.map((item, i) => (
            <span key={i} className="uptime-item">
              <span className="uptime-dot" />
              {item}
            </span>
          ))}
          {/* Duplicate set for seamless loop */}
          {statusItems.map((item, i) => (
            <span key={`dup-${i}`} className="uptime-item">
              <span className="uptime-dot" />
              {item}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
