import { VersionView } from "./version-view";

export default async function VersionPage({
  params,
}: {
  params: Promise<{ name: string; n: string }>;
}) {
  const { name, n } = await params;
  return <VersionView name={decodeURIComponent(name)} version={Number(n)} />;
}
