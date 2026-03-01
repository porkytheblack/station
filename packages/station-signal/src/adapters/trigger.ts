/**
 * Minimal adapter interface for remote trigger operations.
 * Unlike the full SignalQueueAdapter (14 methods), TriggerAdapter
 * handles only the trigger path — used when signals are triggered
 * from a remote client against a Station server.
 */
export interface TriggerAdapter {
  trigger(signalName: string, input: unknown): Promise<string>;
  triggerBroadcast?(broadcastName: string, input: unknown): Promise<string>;
  ping?(): Promise<boolean>;
}
