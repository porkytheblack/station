"use client";

import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useApi, type BroadcastMeta, type SchemaField } from "../../hooks/use-api";
import { useStation } from "../../hooks/use-station";
import { useBreadcrumb } from "../../hooks/use-breadcrumb";
import { StatusBadge } from "../../components/status-badge";
import { DAGView, computeLayers, type DagNode } from "../../components/dag-view";
import { NodeDetail } from "../../components/node-detail";
import { WorkflowNodeSidebar } from "../../components/workflow-node-sidebar";
import { SchemaForm } from "../../components/schema-form";
import { RelativeTime } from "../../components/relative-time";

interface BroadcastLogEntry {
  runId: string;
  signalName: string;
  level: string;
  message: string;
  timestamp: string;
  nodeName: string;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function computeDuration(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return "\u2014";
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  return formatMs(end - start);
}

export function BroadcastDetail() {
  const params = useParams();
  const id = params.id as string;
  const isUUID = /^[0-9a-f]{8}-/.test(id);

  if (isUUID) {
    return <BroadcastRunView id={id} />;
  }
  return <BroadcastNameView name={id} />;
}

/* ─── Name View (workflow overview + runs list) ──────────── */

function BroadcastNameView({ name }: { name: string }) {
  const decodedName = decodeURIComponent(name);
  const api = useApi();
  const { events } = useStation();
  const [broadcast, setBroadcast] = useState<BroadcastMeta | null>(null);
  const [broadcastRuns, setBroadcastRuns] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [inputJson, setInputJson] = useState("{}");
  const [triggering, setTriggering] = useState(false);
  const [rootInputSchema, setRootInputSchema] = useState<SchemaField | null>(null);
  const [showTrigger, setShowTrigger] = useState(false);

  useBreadcrumb(
    [{ label: "Broadcasts", href: "/broadcasts" }, { label: decodedName }],
    "broadcasts",
  );

  const loadRuns = useCallback(() => {
    api.getBroadcastRuns(name).then((r) => setBroadcastRuns(r.data)).catch((e) => console.error("Failed to refresh broadcast runs:", e));
  }, [name]);

  useEffect(() => {
    async function load() {
      try {
        const [bcRes, runsRes] = await Promise.all([
          api.getBroadcast(name),
          api.getBroadcastRuns(name),
        ]);
        setBroadcast(bcRes.data);
        setBroadcastRuns(runsRes.data);
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.error("Failed to load broadcast:", err.message);
        }
      }
      setLoading(false);
    }
    load();
  }, [name]);

  useEffect(() => {
    if (!broadcast) return;
    const rootNodes = broadcast.nodes.filter((n) => n.dependsOn.length === 0);
    if (rootNodes.length === 1) {
      api.getSignal(rootNodes[0].signalName)
        .then((res) => setRootInputSchema(res.data.inputSchema))
        .catch((e) => console.error("Failed to load root input schema:", e));
    }
  }, [broadcast]);

  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[0];
    if (latest.type.startsWith("broadcast:") || latest.type.startsWith("node:")) {
      loadRuns();
    }
  }, [events.length, loadRuns]);

  async function handleTrigger() {
    setTriggering(true);
    try {
      const input = JSON.parse(inputJson);
      await api.triggerBroadcast(name, input);
      setInputJson("{}");
      setShowTrigger(false);
      setTimeout(loadRuns, 300);
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error("Trigger failed:", err.message);
      }
    }
    setTriggering(false);
  }

  if (loading) {
    return (
      <div>
        <h1 className="page-title">{decodedName}</h1>
        <div className="loading-bar"><div className="loading-bar-fill" /></div>
      </div>
    );
  }

  if (!broadcast) {
    return (
      <div>
        <h1 className="page-title">{decodedName}</h1>
        <div className="empty-state">
          <p className="empty-state-text">Broadcast not found.</p>
        </div>
      </div>
    );
  }

  const dagNodes: DagNode[] = broadcast.nodes.map((n) => ({
    name: n.name,
    signalName: n.signalName,
    dependsOn: n.dependsOn,
  }));

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title" style={{ marginBottom: 0 }}>{decodedName}</h1>
        <div className="page-header-actions">
          <button className="btn btn--primary" onClick={() => setShowTrigger(!showTrigger)}>
            {showTrigger ? "Close" : "Trigger"}
          </button>
        </div>
      </div>

      {/* Trigger form — collapsible */}
      {showTrigger && (
        <div className="detail-section">
          <SchemaForm
            schema={rootInputSchema}
            value={inputJson}
            onChange={setInputJson}
          />
          <div style={{ marginTop: "0.5rem" }}>
            <button
              className="btn btn--primary"
              onClick={handleTrigger}
              disabled={triggering}
            >
              {triggering ? "Dispatching..." : "Dispatch"}
            </button>
          </div>
        </div>
      )}

      {/* Runs list — primary content */}
      <div className="detail-section">
        <div className="detail-section-label">Runs</div>
        {broadcastRuns.length === 0 ? (
          <div className="empty-state">
            <p className="empty-state-text">No runs yet. Trigger a broadcast to get started.</p>
          </div>
        ) : (
          <table className="station-table">
            <thead>
              <tr>
                <th>Status</th>
                <th>Run</th>
                <th>Duration</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {broadcastRuns.map((run: any, i: number) => (
                <tr
                  key={run.id}
                  className="reveal-item clickable-row"
                  style={{ animationDelay: `${i * 40}ms` }}
                  onClick={() => window.location.assign(`/broadcasts/${run.id}`)}
                >
                  <td><StatusBadge status={run.status} /></td>
                  <td className="mono">{run.id.slice(0, 8)}</td>
                  <td className="mono">{computeDuration(run.startedAt, run.completedAt)}</td>
                  <td><RelativeTime date={run.createdAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Configuration */}
      <div className="detail-section">
        <div className="detail-section-label">Configuration</div>
        <div className="config-grid">
          <div className="config-item">
            <span className="config-item-label">Failure Policy</span>
            <span className="config-item-value">{broadcast.failurePolicy}</span>
          </div>
          <div className="config-item">
            <span className="config-item-label">Timeout</span>
            <span className="config-item-value">{broadcast.timeout !== null ? formatMs(broadcast.timeout) : "\u2014"}</span>
          </div>
          <div className="config-item">
            <span className="config-item-label">Schedule</span>
            <span className="config-item-value">{broadcast.interval ?? "Manual trigger"}</span>
          </div>
        </div>
      </div>

      {/* Workflow definition */}
      <div className="detail-section">
        <div className="detail-section-label">Workflow</div>
        <DAGView nodes={dagNodes} />
      </div>
    </div>
  );
}

/* ─── Run View (GitHub Actions style) ────────────────────── */

function BroadcastRunView({ id }: { id: string }) {
  const api = useApi();
  const router = useRouter();
  const { events } = useStation();
  const [broadcastRun, setBroadcastRun] = useState<any>(null);
  const [nodeRuns, setNodeRuns] = useState<any[]>([]);
  const [broadcastMeta, setBroadcastMeta] = useState<BroadcastMeta | null>(null);
  const [logs, setLogs] = useState<BroadcastLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const signalRunIdsRef = useRef<Set<string>>(new Set());
  const autoSelectedRef = useRef(false);

  useBreadcrumb(
    broadcastRun
      ? [
          { label: "Broadcasts", href: "/broadcasts" },
          { label: broadcastRun.broadcastName, href: `/broadcasts/${encodeURIComponent(broadcastRun.broadcastName)}` },
          { label: `Run ${id.slice(0, 8)}` },
        ]
      : [{ label: "Broadcasts", href: "/broadcasts" }, { label: `Run ${id.slice(0, 8)}` }],
    "broadcasts",
  );

  useEffect(() => {
    async function load() {
      try {
        const [runRes, nodesRes, logsRes] = await Promise.all([
          api.getBroadcastRun(id),
          api.getBroadcastRunNodes(id),
          api.getBroadcastRunLogs(id),
        ]);
        setBroadcastRun(runRes.data);
        setNodeRuns(nodesRes.data);
        setLogs(logsRes.data);

        const ids = new Set<string>();
        for (const nr of nodesRes.data) {
          if (nr.signalRunId) ids.add(nr.signalRunId);
        }
        signalRunIdsRef.current = ids;

        // Auto-select: first failed, then first running, then first node
        if (!autoSelectedRef.current && nodesRes.data.length > 0) {
          autoSelectedRef.current = true;
          const failed = nodesRes.data.find((nr: any) => nr.status === "failed");
          const running = nodesRes.data.find((nr: any) => nr.status === "running");
          setSelectedNode((failed ?? running ?? nodesRes.data[0]).nodeName);
        }

        if (runRes.data.broadcastName) {
          api.getBroadcast(runRes.data.broadcastName)
            .then((r) => setBroadcastMeta(r.data))
            .catch((e) => console.error("Failed to load broadcast meta:", e));
        }
      } catch (err: unknown) {
        if (err instanceof Error) {
          console.error("Failed to load broadcast run:", err.message);
        }
      }
      setLoading(false);
    }
    load();
  }, [id]);

  useEffect(() => {
    if (events.length === 0) return;
    const latest = events[0];

    if (latest.type === "log:output") {
      const eventRunId = latest.data.runId as string;
      if (signalRunIdsRef.current.has(eventRunId)) {
        const node = nodeRuns.find((nr: any) => nr.signalRunId === eventRunId);
        setLogs((prev) => [...prev, {
          runId: eventRunId,
          signalName: latest.data.signalName as string,
          level: latest.data.level as string,
          message: latest.data.message as string,
          timestamp: (latest.data.timestamp as string) ?? latest.timestamp,
          nodeName: node?.nodeName ?? "",
        }]);
      }
    }

    if (latest.type.startsWith("broadcast:") || latest.type.startsWith("node:")) {
      api.getBroadcastRun(id).then((r) => setBroadcastRun(r.data)).catch((e) => console.error("Failed to refresh broadcast run:", e));
      api.getBroadcastRunNodes(id).then((r) => {
        setNodeRuns(r.data);
        const ids = new Set<string>();
        for (const nr of r.data) {
          if (nr.signalRunId) ids.add(nr.signalRunId);
        }
        signalRunIdsRef.current = ids;
      }).catch((e) => console.error("Failed to refresh node runs:", e));
    }
  }, [events.length, id, nodeRuns]);

  async function handleCancel() {
    setCancelling(true);
    try {
      await api.cancelBroadcastRun(id);
      const res = await api.getBroadcastRun(id);
      setBroadcastRun(res.data);
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error("Cancel failed:", err.message);
      }
    }
    setCancelling(false);
  }

  async function handleRerun() {
    setRerunning(true);
    try {
      const res = await api.rerunBroadcastRun(id);
      router.push(`/broadcasts/${res.data.id}`);
    } catch (err: unknown) {
      if (err instanceof Error) {
        console.error("Rerun failed:", err.message);
      }
    }
    setRerunning(false);
  }

  // Build deps map from broadcast metadata
  const depsMap = useMemo(() => {
    const map = new Map<string, string[]>();
    if (broadcastMeta) {
      for (const node of broadcastMeta.nodes) {
        map.set(node.name, node.dependsOn);
      }
    }
    return map;
  }, [broadcastMeta]);

  // Build DAG nodes for compact view
  const dagNodes: DagNode[] = useMemo(() =>
    nodeRuns.map((nr: any) => ({
      name: nr.nodeName,
      signalName: nr.signalName,
      dependsOn: depsMap.get(nr.nodeName) ?? [],
      status: nr.status,
      startedAt: nr.startedAt,
      completedAt: nr.completedAt,
    })),
    [nodeRuns, depsMap],
  );

  // Build sidebar nodes with tiers
  const sidebarNodes = useMemo(() => {
    if (dagNodes.length === 0) return [];
    const layers = computeLayers(dagNodes);
    const tierMap = new Map<string, number>();
    layers.forEach((layer, idx) => {
      for (const node of layer) {
        tierMap.set(node.name, idx);
      }
    });
    // Flatten layers to get topological order
    const ordered = layers.flat();
    return ordered.map((node) => {
      const nr = nodeRuns.find((r: any) => r.nodeName === node.name);
      return {
        nodeName: node.name,
        signalName: node.signalName,
        status: nr?.status ?? "pending",
        startedAt: nr?.startedAt,
        completedAt: nr?.completedAt,
        tier: tierMap.get(node.name) ?? 0,
      };
    });
  }, [dagNodes, nodeRuns]);

  // Filter logs for selected node
  const selectedNodeLogs = useMemo(() => {
    if (!selectedNode) return [];
    return logs
      .filter((l) => l.nodeName === selectedNode)
      .map(({ level, message, timestamp }) => ({ level, message, timestamp }));
  }, [logs, selectedNode]);

  const selectedNodeRun = selectedNode
    ? nodeRuns.find((nr: any) => nr.nodeName === selectedNode)
    : null;

  if (loading) {
    return (
      <div>
        <h1 className="page-title">Broadcast Run</h1>
        <div className="loading-bar"><div className="loading-bar-fill" /></div>
      </div>
    );
  }

  if (!broadcastRun) {
    return (
      <div>
        <h1 className="page-title">Broadcast Run</h1>
        <div className="empty-state">
          <p className="empty-state-text">Broadcast run not found.</p>
        </div>
      </div>
    );
  }

  const canCancel = broadcastRun.status === "pending" || broadcastRun.status === "running";
  const canRerun = broadcastRun.status === "failed" || broadcastRun.status === "completed" || broadcastRun.status === "cancelled";

  return (
    <div>
      {/* Header with status and metadata inline */}
      <div className="page-header">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <StatusBadge status={broadcastRun.status} />
          <Link
            href={`/broadcasts/${encodeURIComponent(broadcastRun.broadcastName)}`}
            className="page-title"
            style={{ marginBottom: 0, textDecoration: "none" }}
          >
            {broadcastRun.broadcastName}
          </Link>
          <span className="mono" style={{ color: "var(--muted)", fontSize: "0.75rem" }}>
            {computeDuration(broadcastRun.startedAt, broadcastRun.completedAt)}
          </span>
        </div>
        <div className="page-header-actions">
          {canRerun && (
            <button className="btn btn--primary" onClick={handleRerun} disabled={rerunning}>
              {rerunning ? "Rerunning..." : "Rerun"}
            </button>
          )}
          {canCancel && (
            <button className="btn btn--danger" onClick={handleCancel} disabled={cancelling}>
              {cancelling ? "Cancelling..." : "Cancel"}
            </button>
          )}
        </div>
      </div>

      {broadcastRun.error && (
        <div className="detail-section">
          <div className="error-block">{broadcastRun.error}</div>
        </div>
      )}

      {/* Compact DAG overview */}
      {dagNodes.length > 0 && (
        <div className="detail-section">
          <DAGView
            nodes={dagNodes}
            onNodeClick={(name) => setSelectedNode(name)}
            selectedNode={selectedNode ?? undefined}
            compact
          />
        </div>
      )}

      {/* Sidebar + Node detail panel */}
      {sidebarNodes.length > 0 && (
        <div className="workflow-layout">
          <WorkflowNodeSidebar
            nodes={sidebarNodes}
            selectedNode={selectedNode}
            onSelectNode={setSelectedNode}
          />
          {selectedNodeRun ? (
            <NodeDetail
              node={selectedNodeRun}
              logs={selectedNodeLogs}
            />
          ) : (
            <div className="workflow-panel">
              <div className="empty-state">
                <p className="empty-state-text">Select a node to view details.</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
