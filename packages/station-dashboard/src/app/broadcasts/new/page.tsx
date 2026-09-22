"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useApi, type DynamicValidationResult, type SignalMeta } from "../../hooks/use-api";
import { useBreadcrumb } from "../../hooks/use-breadcrumb";
import { BroadcastBuilder } from "../components/broadcast-builder";

const STARTER_SPEC = JSON.stringify(
  {
    name: "myBroadcast",
    failurePolicy: "fail-fast",
    timeout: 300000,
    nodes: [
      {
        name: "first",
        signalName: "<existing-signal-name>",
        dependsOn: [],
      },
    ],
  },
  null,
  2,
);

export default function NewDynamicBroadcastPage() {
  const api = useApi();
  const router = useRouter();
  const [json, setJson] = useState(STARTER_SPEC);
  const [validation, setValidation] = useState<DynamicValidationResult | null>(null);
  const [signals, setSignals] = useState<SignalMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useBreadcrumb(
    [
      { label: "Broadcasts", href: "/broadcasts" },
      { label: "New dynamic" },
    ],
    "broadcasts",
  );

  useEffect(() => {
    api.getSignals().then((res) => setSignals(res.data)).catch(() => {});
  }, []);

  async function handleValidate() {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      setError(`JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    try {
      const res = await api.validateBroadcastDefinition(parsed as never);
      setValidation(res.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSave() {
    setError(null);
    setBusy(true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      setError(`JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
      setBusy(false);
      return;
    }
    try {
      const res = await api.saveBroadcastDefinition(parsed as never);
      router.push(`/broadcasts/dyn/${encodeURIComponent(res.data.name)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1 className="page-title">New dynamic broadcast</h1>
      <BroadcastBuilder
        json={json}
        onChange={setJson}
        validation={validation}
        onValidationStale={() => setValidation(null)}
        signals={signals}
        onValidate={handleValidate}
        onSave={handleSave}
        saveLabel={busy ? "Saving..." : "Save (creates v1)"}
        saving={busy}
        error={error}
      />
    </div>
  );
}
