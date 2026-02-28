"use client";

import { useTheme } from "./theme-provider";

export interface DagNode {
  name: string;
  signalName: string;
  dependsOn: string[];
  status?: string;
  startedAt?: string;
  completedAt?: string;
}

interface DagViewProps {
  nodes: DagNode[];
  onNodeClick?: (nodeName: string) => void;
  selectedNode?: string;
  compact?: boolean;
}

type StatusColorSet = Record<string, { bar: string; fill: string; stroke: string; text: string }>;

export const STATUS_COLORS: StatusColorSet = {
  completed: { bar: "#4A6741", fill: "rgba(74, 103, 65, 0.06)", stroke: "#4A6741", text: "#4A6741" },
  running:   { bar: "#6B9962", fill: "rgba(107, 153, 98, 0.08)", stroke: "#6B9962", text: "#4A6741" },
  failed:    { bar: "#8B5A2B", fill: "rgba(139, 90, 43, 0.06)", stroke: "#8B5A2B", text: "#8B5A2B" },
  pending:   { bar: "#D4CEBF", fill: "#F9F7F3", stroke: "#D4CEBF", text: "#8A8A8E" },
  cancelled: { bar: "#AEAEB2", fill: "rgba(139, 90, 43, 0.03)", stroke: "#AEAEB2", text: "#8A8A8E" },
  skipped:   { bar: "#AEAEB2", fill: "transparent", stroke: "#AEAEB2", text: "#8A8A8E" },
};

const DARK_STATUS_COLORS: StatusColorSet = {
  completed: { bar: "#6B9962", fill: "rgba(107, 153, 98, 0.12)", stroke: "#6B9962", text: "#8BB882" },
  running:   { bar: "#8BB882", fill: "rgba(139, 185, 130, 0.1)", stroke: "#8BB882", text: "#8BB882" },
  failed:    { bar: "#C4834A", fill: "rgba(196, 131, 74, 0.1)", stroke: "#C4834A", text: "#D4975C" },
  pending:   { bar: "#4A4A4C", fill: "#252527", stroke: "#4A4A4C", text: "#8A8A8E" },
  cancelled: { bar: "#6A6A6E", fill: "rgba(60, 60, 62, 0.3)", stroke: "#6A6A6E", text: "#8A8A8E" },
  skipped:   { bar: "#6A6A6E", fill: "transparent", stroke: "#6A6A6E", text: "#8A8A8E" },
};

const DEFAULT_COLORS = { bar: "#4A6741", fill: "#FFFFFF", stroke: "#D4CEBF", text: "#1C1C1E" };
const DARK_DEFAULT_COLORS = { bar: "#6B9962", fill: "#222224", stroke: "#4A4A4C", text: "#E8E4DC" };

export function useStatusColors() {
  const { theme } = useTheme();
  return theme === "dark" ? DARK_STATUS_COLORS : STATUS_COLORS;
}

const FULL_NODE_WIDTH = 184;
const FULL_NODE_HEIGHT = 60;
const COMPACT_NODE_WIDTH = 140;
const COMPACT_NODE_HEIGHT = 36;
const STATUS_BAR_HEIGHT = 4;
const FULL_GAP_X = 48;
const FULL_GAP_Y = 40;
const COMPACT_GAP_X = 32;
const COMPACT_GAP_Y = 28;
const FULL_PADDING_X = 32;
const FULL_PADDING_Y = 24;
const COMPACT_PADDING_X = 20;
const COMPACT_PADDING_Y = 16;

interface NodePosition {
  x: number;
  y: number;
  node: DagNode;
}

function computeLayers(nodes: DagNode[]): DagNode[][] {
  if (nodes.length === 0) return [];

  const nameToNode = new Map<string, DagNode>();
  for (const node of nodes) {
    nameToNode.set(node.name, node);
  }

  const tierCache = new Map<string, number>();

  function getTier(name: string, visiting: Set<string>): number {
    if (tierCache.has(name)) return tierCache.get(name)!;
    if (visiting.has(name)) return 0;
    visiting.add(name);

    const node = nameToNode.get(name);
    if (!node || node.dependsOn.length === 0) {
      tierCache.set(name, 0);
      return 0;
    }

    let maxParentTier = 0;
    for (const dep of node.dependsOn) {
      if (nameToNode.has(dep)) {
        maxParentTier = Math.max(maxParentTier, getTier(dep, visiting) + 1);
      }
    }

    tierCache.set(name, maxParentTier);
    return maxParentTier;
  }

  for (const node of nodes) {
    getTier(node.name, new Set());
  }

  const layerMap = new Map<number, DagNode[]>();
  for (const node of nodes) {
    const tier = tierCache.get(node.name) ?? 0;
    if (!layerMap.has(tier)) {
      layerMap.set(tier, []);
    }
    layerMap.get(tier)!.push(node);
  }

  const maxTier = Math.max(...Array.from(layerMap.keys()), 0);
  const layers: DagNode[][] = [];
  for (let i = 0; i <= maxTier; i++) {
    layers.push(layerMap.get(i) ?? []);
  }

  return layers.filter((l) => l.length > 0);
}

interface Dims {
  nodeWidth: number;
  nodeHeight: number;
  gapX: number;
  gapY: number;
  paddingX: number;
  paddingY: number;
}

function computePositions(layers: DagNode[][], dims: Dims): {
  positions: Map<string, NodePosition>;
  svgWidth: number;
  svgHeight: number;
} {
  const positions = new Map<string, NodePosition>();
  if (layers.length === 0) return { positions, svgWidth: 0, svgHeight: 0 };

  const { nodeWidth, nodeHeight, gapX, gapY, paddingX, paddingY } = dims;
  const maxNodesInLayer = Math.max(1, ...layers.map((l) => l.length));
  const svgWidth = maxNodesInLayer * (nodeWidth + gapX) - gapX + paddingX * 2;
  const svgHeight = layers.length * (nodeHeight + gapY) - gapY + paddingY * 2;

  for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
    const layer = layers[layerIdx];
    const layerWidth = layer.length * (nodeWidth + gapX) - gapX;
    const offsetX = (svgWidth - layerWidth) / 2;
    const y = paddingY + layerIdx * (nodeHeight + gapY);

    for (let nodeIdx = 0; nodeIdx < layer.length; nodeIdx++) {
      const x = offsetX + nodeIdx * (nodeWidth + gapX);
      positions.set(layer[nodeIdx].name, { x, y, node: layer[nodeIdx] });
    }
  }

  return { positions, svgWidth, svgHeight };
}

function formatDuration(startedAt?: string, completedAt?: string): string | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export { computeLayers };

export function DAGView({ nodes, onNodeClick, selectedNode, compact }: DagViewProps) {
  const { theme } = useTheme();
  const isDark = theme === "dark";
  const statusColors = isDark ? DARK_STATUS_COLORS : STATUS_COLORS;
  const defaultColors = isDark ? DARK_DEFAULT_COLORS : DEFAULT_COLORS;

  if (nodes.length === 0) {
    return (
      <div className="empty-state">
        <p className="empty-state-text">No nodes.</p>
      </div>
    );
  }

  const nodeWidth = compact ? COMPACT_NODE_WIDTH : FULL_NODE_WIDTH;
  const nodeHeight = compact ? COMPACT_NODE_HEIGHT : FULL_NODE_HEIGHT;
  const gapX = compact ? COMPACT_GAP_X : FULL_GAP_X;
  const gapY = compact ? COMPACT_GAP_Y : FULL_GAP_Y;
  const paddingX = compact ? COMPACT_PADDING_X : FULL_PADDING_X;
  const paddingY = compact ? COMPACT_PADDING_Y : FULL_PADDING_Y;

  const layers = computeLayers(nodes);
  const { positions, svgWidth, svgHeight } = computePositions(layers, {
    nodeWidth, nodeHeight, gapX, gapY, paddingX, paddingY,
  });
  const isRunMode = nodes.some((n) => n.status !== undefined);

  const statusMap = new Map<string, string>();
  for (const node of nodes) {
    if (node.status) statusMap.set(node.name, node.status);
  }

  const edges: { from: string; to: string }[] = [];
  for (const node of nodes) {
    for (const dep of node.dependsOn) {
      if (positions.has(dep)) {
        edges.push({ from: dep, to: node.name });
      }
    }
  }

  return (
    <div className="dag-container">
      <svg
        width={svgWidth}
        height={svgHeight}
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        style={{ display: "block", margin: "0 auto" }}
      >
        <defs>
          <marker id="dag-arrow" viewBox="0 0 6 6" refX="6" refY="3"
            markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 6 3 L 0 6 z" fill={isDark ? "#4A4A4C" : "#D4CEBF"} />
          </marker>
          <marker id="dag-arrow-active" viewBox="0 0 6 6" refX="6" refY="3"
            markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 6 3 L 0 6 z" fill={isDark ? "#6B9962" : "#4A6741"} />
          </marker>
        </defs>

        {/* Edges */}
        {edges.map((edge) => {
          const fromPos = positions.get(edge.from);
          const toPos = positions.get(edge.to);
          if (!fromPos || !toPos) return null;

          const sourceCompleted = statusMap.get(edge.from) === "completed";
          const isSkipped = statusMap.get(edge.to) === "skipped";

          const x1 = fromPos.x + nodeWidth / 2;
          const y1 = fromPos.y + nodeHeight;
          const x2 = toPos.x + nodeWidth / 2;
          const y2 = toPos.y;
          const midY = (y1 + y2) / 2;
          const d = `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;

          return (
            <path
              key={`${edge.from}->${edge.to}`}
              d={d}
              className={`dag-edge${sourceCompleted ? " dag-edge--active" : ""}`}
              strokeDasharray={isSkipped ? "4 3" : undefined}
              markerEnd={`url(#${sourceCompleted ? "dag-arrow-active" : "dag-arrow"})`}
            />
          );
        })}

        {/* Nodes */}
        {Array.from(positions.values()).map(({ x, y, node }) => {
          const hasStatus = node.status !== undefined && node.status !== null;
          const colors = hasStatus
            ? statusColors[node.status!] ?? defaultColors
            : defaultColors;
          const isSkipped = node.status === "skipped";
          const isSelected = selectedNode === node.name;
          const isRunning = node.status === "running";
          const dur = formatDuration(node.startedAt, node.completedAt);

          const maxNameLen = compact ? 14 : 18;
          const truncName = node.name.length > maxNameLen ? node.name.slice(0, maxNameLen - 1) + "\u2026" : node.name;
          const truncSignal = node.signalName.length > 22 ? node.signalName.slice(0, 21) + "\u2026" : node.signalName;

          return (
            <g
              key={node.name}
              className={`dag-node${isSelected ? " dag-node--selected" : ""}`}
              onClick={() => onNodeClick?.(node.name)}
              style={{ cursor: onNodeClick ? "pointer" : "default" }}
              role={onNodeClick ? "button" : undefined}
              tabIndex={onNodeClick ? 0 : undefined}
              aria-label={`${node.name}${hasStatus ? ", " + node.status : ""}`}
              onKeyDown={(e) => {
                if (onNodeClick && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onNodeClick(node.name);
                }
              }}
            >
              {/* Running pulse ring */}
              {isRunning && (
                <rect
                  x={x - 3} y={y - 3}
                  width={nodeWidth + 6} height={nodeHeight + 6}
                  rx={7} fill="none" stroke={isDark ? "#8BB882" : "#6B9962"} strokeWidth={2}
                >
                  <animate
                    attributeName="opacity"
                    values="0;0.5;0"
                    dur="2.4s"
                    repeatCount="indefinite"
                  />
                </rect>
              )}

              {/* Node body */}
              <rect
                x={x} y={y}
                width={nodeWidth} height={nodeHeight}
                rx={4} fill={colors.fill} stroke={colors.stroke}
                strokeWidth={isSelected ? 2.5 : 1.5}
                strokeDasharray={isSkipped ? "4 3" : undefined}
              />

              {/* Status bar (top edge) */}
              <rect x={x} y={y} width={nodeWidth} height={STATUS_BAR_HEIGHT} rx={4} fill={colors.bar} />
              <rect x={x} y={y + 2} width={nodeWidth} height={2} fill={colors.bar} />

              {/* Node name */}
              <text
                x={x + 8} y={compact ? y + (nodeHeight / 2) + 2 : y + STATUS_BAR_HEIGHT + 16}
                fill={colors.text} dominantBaseline="middle"
                style={{ fontSize: compact ? "10px" : "11px", fontFamily: "var(--font-mono)", fontWeight: 500 }}
              >
                {truncName}
              </text>

              {/* In compact mode, only show status icon on the right */}
              {compact && isRunMode && hasStatus && (
                <text
                  x={x + nodeWidth - 8} y={y + (nodeHeight / 2) + 2}
                  fill={colors.text} opacity={0.5} dominantBaseline="middle" textAnchor="end"
                  style={{ fontSize: "8px", fontFamily: "var(--font-mono)", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}
                >
                  {dur ?? node.status}
                </text>
              )}

              {/* Full mode extras */}
              {!compact && (
                <>
                  {/* Duration (top right, run mode only) */}
                  {isRunMode && dur && (
                    <text
                      x={x + nodeWidth - 10} y={y + STATUS_BAR_HEIGHT + 16}
                      fill={colors.text} opacity={0.6} dominantBaseline="middle" textAnchor="end"
                      style={{ fontSize: "9px", fontFamily: "var(--font-mono)" }}
                    >
                      {dur}
                    </text>
                  )}

                  {/* Signal name (bottom left) */}
                  <text
                    x={x + 10} y={y + nodeHeight - 10}
                    fill={colors.text} opacity={0.45} dominantBaseline="middle"
                    style={{ fontSize: "9px", fontFamily: "var(--font-mono)" }}
                  >
                    {truncSignal}
                  </text>

                  {/* Status label (bottom right, run mode only) */}
                  {isRunMode && hasStatus && (
                    <text
                      x={x + nodeWidth - 10} y={y + nodeHeight - 10}
                      fill={colors.text} opacity={0.5} dominantBaseline="middle" textAnchor="end"
                      style={{ fontSize: "8px", fontFamily: "var(--font-mono)", textTransform: "uppercase" as const, letterSpacing: "0.05em" }}
                    >
                      {node.status}
                    </text>
                  )}
                </>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
