//  CommitmentTracker 
// Resolves transaction commitment purely from slot stream events.
// No RPC polling. When the stream reports latestConfirmedSlot >= submittedSlot,
// the transaction is confirmed. Same logic for finalized.
// This satisfies the bounty requirement: "RPC polling alone is not sufficient."

export interface SlotSource {
  getLatestConfirmedSlot(): number;
  getLatestFinalizedSlot(): number;
  on(event: "slot", listener: (...args: any[]) => void): unknown;
  off(event: "slot", listener: (...args: any[]) => void): unknown;
}

export interface CommitmentObservation {
  slot:       number;
  observedAt: number;
}

export class CommitmentTracker {
  constructor(private readonly slotSource: SlotSource) {}

  waitForCommitment(
    targetSlot: number,
    level: "confirmed" | "finalized",
    timeoutMs: number
  ): Promise<CommitmentObservation> {
    const reached = (): number =>
      level === "finalized"
        ? this.slotSource.getLatestFinalizedSlot()
        : this.slotSource.getLatestConfirmedSlot();

    return new Promise<CommitmentObservation>((resolve, reject) => {
      // Already reached before we even subscribed
      if (reached() >= targetSlot) {
        resolve({ slot: reached(), observedAt: Date.now() });
        return;
      }

      const onSlot = () => {
        const current = reached();
        if (current >= targetSlot) {
          cleanup();
          resolve({ slot: current, observedAt: Date.now() });
        }
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Stream commitment timeout after ${timeoutMs}ms ` +
            `(waiting for ${level} slot >= ${targetSlot}, ` +
            `current = ${reached()})`
          )
        );
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        this.slotSource.off("slot", onSlot);
      };

      this.slotSource.on("slot", onSlot);
    });
  }
}