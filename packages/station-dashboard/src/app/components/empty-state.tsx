export function EmptyState({ text }: { text: string }) {
  return (
    <div className="empty-state">
      <p className="empty-state-text">{text}</p>
    </div>
  );
}
