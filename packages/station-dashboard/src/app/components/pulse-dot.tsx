export function PulseDot({ connected }: { connected: boolean }) {
  return (
    <div
      className={`pulse-dot ${connected ? "" : "pulse-dot--disconnected"}`}
      title={connected ? "Connected" : "Disconnected"}
    />
  );
}
