"use client";
import type { BrowserTarget } from "station-browser-use";
export interface LocatorDraft { by: BrowserTarget["by"]; value: string; role: string; exact: boolean; frames: string; nth: string }
export const emptyLocator: LocatorDraft = { by: "selector", value: "", role: "button", exact: true, frames: "", nth: "" };
export function browserTarget(draft: LocatorDraft): BrowserTarget {
  const frame = draft.frames.split("\n").map(value => value.trim()).filter(Boolean);
  const extra = { ...(frame.length ? { frame } : {}), ...(draft.nth !== "" ? { nth: Number(draft.nth) } : {}) };
  return draft.by === "role" ? { by: "role", role: draft.role, ...(draft.value ? { name: draft.value } : {}), exact: draft.exact, ...extra } : { by: draft.by, value: draft.value, exact: draft.exact, ...extra };
}
export function BrowserTargetFields({ value, onChange, disabled, optional = false }: { value: LocatorDraft; onChange: (value: LocatorDraft) => void; disabled?: boolean; optional?: boolean }) {
  return <div>
    <label className="execution-field"><span>Find element by{optional ? " (optional)" : ""}</span><select className="input-text" aria-label="Locator strategy" value={value.by} disabled={disabled} onChange={event => onChange({ ...value, by: event.target.value as LocatorDraft["by"] })}>{[["selector", "CSS selector"], ["role", "Role and name"], ["text", "Text"], ["label", "Label"], ["testId", "Test ID"]].map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    {value.by === "role" && <label className="execution-field"><span>Role</span><input className="input-text" aria-label="Element role" value={value.role} disabled={disabled} onChange={event => onChange({ ...value, role: event.target.value })} /></label>}
    <label className="execution-field"><span>{value.by === "role" ? "Accessible name" : value.by === "selector" ? "Element selector" : "Element value"}</span><input className="input-text" aria-label={value.by === "selector" ? "Element selector" : "Locator value"} value={value.value} disabled={disabled} onChange={event => onChange({ ...value, value: event.target.value })} /></label>
    {value.by !== "selector" && <label className="execution-note"><input type="checkbox" checked={value.exact} disabled={disabled} onChange={event => onChange({ ...value, exact: event.target.checked })} /> Exact match</label>}
    <details><summary className="execution-note">Frame and match options</summary><label className="execution-field"><span>Frame selectors, outermost first (one per line)</span><textarea className="input-textarea" aria-label="Frame selectors" rows={2} value={value.frames} disabled={disabled} onChange={event => onChange({ ...value, frames: event.target.value })} /></label><label className="execution-field"><span>Match index (optional, starts at zero)</span><input className="input-text" aria-label="Match index" type="number" min={0} max={9999} value={value.nth} disabled={disabled} onChange={event => onChange({ ...value, nth: event.target.value })} /></label></details>
  </div>;
}
