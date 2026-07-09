import { BeaconDetail } from "./beacon-detail";

export default async function BeaconPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <BeaconDetail name={decodeURIComponent(name)} />;
}
