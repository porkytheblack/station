import { Sidebar } from "../components/Sidebar";

export default function DocsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="docs-layout">
      <Sidebar />
      <main className="docs-content">{children}</main>
    </div>
  );
}
