import { SignalDetail } from "./signal-detail";

export function generateStaticParams() {
  return [{ name: "_" }];
}

export default function SignalDetailPage() {
  return <SignalDetail />;
}
