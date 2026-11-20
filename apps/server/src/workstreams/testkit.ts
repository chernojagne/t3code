import {
  MessageId,
  type OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
  type WorkstreamId,
  type WorkstreamMemoryEntry,
  WorkstreamMemoryEntryId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";

export const THREAD = ThreadId.make("thread:one");
export const OTHER_THREAD = ThreadId.make("thread:two");

let ordinal = 0;

/** A user or assistant turn item with only the fields the memory digest reads set to real values. */
export function messageItem(role: "user" | "assistant", text: string): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  ordinal += 1;
  const base = {
    id: TurnItemId.make(`turn-item:${ordinal}`),
    threadId: THREAD,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    messageId: MessageId.make(`message:${ordinal}`),
    text,
  };
  return role === "user"
    ? {
        ...base,
        createdBy: "user",
        creationSource: "server",
        type: "user_message",
        inputIntent: "turn_start",
        attachments: [],
      }
    : { ...base, type: "assistant_message", streaming: false };
}

export function memoryEntry(
  input: Omit<Partial<WorkstreamMemoryEntry>, "id"> & {
    readonly id: string;
    readonly text: string;
  },
  workstreamId: WorkstreamId,
): WorkstreamMemoryEntry {
  return {
    workstreamId,
    kind: "fact",
    sourceThreadId: null,
    locked: false,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...input,
    id: WorkstreamMemoryEntryId.make(input.id),
  };
}

/** Counts up, so every id a test allocates is distinct and repeatable. */
export const layerCountingRandom = Layer.sync(SecureRandom.SecureRandom, () => {
  let next = 0;
  return SecureRandom.make((size) => {
    next += 1;
    const bytes = new Uint8Array(size);
    bytes[size - 1] = next % 256;
    bytes[size - 2] = Math.floor(next / 256);
    return bytes;
  });
});
