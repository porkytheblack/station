import { RunDetail } from "./run-detail";

export function generateStaticParams() {
  return [{ id: "_" }];
}

export default function RunDetailPage() {
  return <RunDetail />;
}
