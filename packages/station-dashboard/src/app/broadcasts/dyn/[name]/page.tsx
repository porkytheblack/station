import { DynamicBroadcastDetail } from "./dynamic-detail";

export default async function DynamicBroadcastPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  return <DynamicBroadcastDetail name={decodeURIComponent(name)} />;
}
