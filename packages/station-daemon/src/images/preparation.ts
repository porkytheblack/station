import { randomUUID } from 'node:crypto';
import type { StationNetworkAdapter } from 'station-network';
export interface ImagePreparation { runId: string; signalName: string; state: 'preparing' | 'ready' | 'failed'; startedAt: string; finishedAt?: string; error?: string }
/** Download reservations are separate from execution leases; preparation never claims a run. */
export class ImagePreparations {
  private readonly running = new Map<string, Promise<void>>();
  private readonly records = new Map<string, ImagePreparation>();
  private stopped = false;
  constructor(private readonly options: { adapter: StationNetworkAdapter; networkId: string; stationId: string; maxConcurrent?: number; timeoutMs?: number }) {}
  list(): ImagePreparation[] { return [...this.records.values()].map(r => ({ ...r })); }
  async request(run: { id: string; signalName: string }, prepare: (stillOwned: () => Promise<boolean>) => Promise<void>): Promise<void> {
    const previous = this.records.get(run.id);
    if (this.stopped || this.running.has(run.id) || this.running.size >= (this.options.maxConcurrent ?? 2) || previous?.state === 'failed' && Date.now() - Date.parse(previous.finishedAt!) < 5000) return;
    const token = randomUUID(), name = `image-preparation:${this.options.networkId}:${run.id}`, now = new Date();
    const timeoutMs = this.options.timeoutMs ?? 60000;
    if (!await this.options.adapter.acquireControllerLease({ name, holderId: this.options.stationId, token, expiresAt: new Date(now.getTime() + timeoutMs + 5000) }, now)) return;
    const record: ImagePreparation = { runId: run.id, signalName: run.signalName, state: 'preparing', startedAt: now.toISOString() };
    if (this.records.size >= 512) {
      const old = [...this.records].find(([, r]) => r.state !== 'preparing');
      if (old) this.records.delete(old[0]);
    }
    this.records.set(run.id, record);
    // A slow download must not block SignalRunner's ownership heartbeats.
    const stillOwned = async () => !this.stopped && Date.now() <= now.getTime() + timeoutMs && await this.options.adapter.renewControllerLease(name, this.options.stationId, token, new Date(now.getTime() + timeoutMs + 5000));
    const pending = Promise.resolve().then(() => prepare(stillOwned)).then(() => {
      if (Date.now() > now.getTime() + timeoutMs) throw new Error('Preparation exceeded deadline');
      record.state = 'ready';
    }).catch(() => { record.state = 'failed'; record.error = 'Image preparation failed; verify platform, environment grants and registry availability'; }).finally(async () => {
      record.finishedAt = new Date().toISOString();
      try { await this.options.adapter.releaseControllerLease(name, this.options.stationId, token); } finally { this.running.delete(run.id); }
    });
    this.running.set(run.id, pending);
    void pending.catch(() => {});
  }
  async stop() { this.stopped = true; await Promise.allSettled(this.running.values()); }
}
