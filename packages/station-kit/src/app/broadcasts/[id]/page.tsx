import { BroadcastDetail } from "./broadcast-detail";

export function generateStaticParams() {
  return [{ id: "_" }];
}

export default function BroadcastDetailPage() {
  return <BroadcastDetail />;
}
