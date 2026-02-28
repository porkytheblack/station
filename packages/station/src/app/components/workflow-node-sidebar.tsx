"use client";

import { useStatusColors } from "./dag-view";
import { useTheme } from "./theme-provider";

interface SidebarNode {
  nodeName: string;
  signalName: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  tier: number;
}

interface WorkflowNodeSidebarProps {
  nodes: SidebarNode[];
  selectedNode: string | null;
  onSelectNode: (name: string) => void;
}

const LIGHT_DOT_COLOR = "#D4CEBF";
const DARK_DOT_COLOR = "#4A4A4C";

function formatDuration(startedAt?: string, completedAt?: string): string | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function WorkflowNodeSidebar({ nodes, selectedNode, onSelectNode }: WorkflowNodeSidebarProps) {
  const statusColors = useStatusColors();
  const { theme } = useTheme();
  const defaultDot = theme === "dark" ? DARK_DOT_COLOR : LIGHT_DOT_COLOR;

  return (
    <div className="workflow-sidebar">
      <div className="workflow-sidebar-label">Nodes</div>
      {nodes.map((node) => {
        const isActive = selectedNode === node.nodeName;
        const colors = statusColors[node.status];
        const dotColor = colors?.bar ?? defaultDot;
        const dur = formatDuration(node.startedAt, node.completedAt);
        const isRunning = node.status === "running";
        const isFailed = node.status === "failed";

        return (
          <button
            key={node.nodeName}
            className={`workflow-node-item${isActive ? " workflow-node-item--active" : ""}${isFailed ? " workflow-node-item--failed" : ""}`}
            onClick={() => onSelectNode(node.nodeName)}
            style={{ paddingLeft: `${0.75 + node.tier * 0.75}rem` }}
          >
            <span
              className={`workflow-node-dot${isRunning ? " workflow-node-dot--running" : ""}`}
              style={{ backgroundColor: dotColor }}
            />
            <span className="workflow-node-name">{node.nodeName}</span>
            {dur && <span className="workflow-node-duration">{dur}</span>}
          </button>
        );
      })}
    </div>
  );
}
