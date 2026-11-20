import { planPinnedReorder } from "@t3tools/client-runtime/state/thread-sort";
import type {
  EnvironmentId,
  ThreadId,
  WorkstreamId,
  WorkstreamMutation,
  WorkstreamState,
} from "@t3tools/contracts";
import { topOfPinnedRunOrderKey } from "@t3tools/shared/pinOrderKey";

import type { WorkstreamEntry } from "./workstreamData";

export const UNSORTED_DROP_ID = "unsorted";
const UNSORTED_OPEN_KEY = "unsorted:open";
const UNSORTED_CLOSED_KEY = "unsorted:closed";
/** An unsorted section longer than this starts closed. */
const UNSORTED_AUTO_COLLAPSE_COUNT = 8;

export type WorkstreamDragItem =
  | {
      readonly kind: "workstream";
      readonly environmentId: EnvironmentId;
      readonly workstreamId: WorkstreamId;
    }
  | {
      readonly kind: "thread";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }
  | { readonly kind: "unsorted" };

export function workstreamDragId(environmentId: EnvironmentId, workstreamId: WorkstreamId) {
  return `ws\n${environmentId}\n${workstreamId}`;
}

export function threadDragId(environmentId: EnvironmentId, threadId: ThreadId) {
  return `th\n${environmentId}\n${threadId}`;
}

export function parseWorkstreamDragId(id: string | number): WorkstreamDragItem | null {
  if (id === UNSORTED_DROP_ID) return { kind: "unsorted" };
  const [kind, environmentId, entityId] = String(id).split("\n");
  if (environmentId === undefined || entityId === undefined) return null;
  if (kind === "ws") {
    return {
      kind: "workstream",
      environmentId: environmentId as EnvironmentId,
      workstreamId: entityId as WorkstreamId,
    };
  }
  if (kind === "th") {
    return {
      kind: "thread",
      environmentId: environmentId as EnvironmentId,
      threadId: entityId as ThreadId,
    };
  }
  return null;
}

export function isUnsortedCollapsed(collapsedKeys: ReadonlyArray<string>, count: number): boolean {
  if (collapsedKeys.includes(UNSORTED_CLOSED_KEY)) return true;
  if (collapsedKeys.includes(UNSORTED_OPEN_KEY)) return false;
  return count > UNSORTED_AUTO_COLLAPSE_COUNT;
}

export function unsortedCollapseChange(collapsed: boolean) {
  return {
    remove: [UNSORTED_OPEN_KEY, UNSORTED_CLOSED_KEY],
    add: [collapsed ? UNSORTED_CLOSED_KEY : UNSORTED_OPEN_KEY],
  };
}

/** The mutation that pins a thread at the top of its workstream's pinned run. */
export function pinThreadMutation(state: WorkstreamState, threadId: ThreadId): WorkstreamMutation {
  const workstreamId = state.memberships.find(
    (membership) => membership.threadId === threadId,
  )?.workstreamId;
  const orderKey = topOfPinnedRunOrderKey(
    state.memberships.flatMap((membership) =>
      membership.workstreamId === workstreamId && membership.pinnedAt !== null
        ? [membership.pinOrderKey]
        : [],
    ),
  );
  return {
    type: "thread.pin",
    threadId,
    pinned: true,
    ...(orderKey === null ? {} : { orderKey }),
  };
}

function moveBefore<T>(ids: ReadonlyArray<T>, moved: T, target: T): T[] {
  const from = ids.indexOf(moved);
  const to = ids.indexOf(target);
  if (from < 0 || to < 0) return [...ids];
  const next = ids.filter((id) => id !== moved);
  next.splice(to, 0, moved);
  return next;
}

/**
 * What dropping `active` on `over` asks the server to do. Empty when the drop changes nothing
 * or is not allowed: another environment's workstream, or a reorder outside manual order.
 */
export function planWorkstreamDrop(input: {
  readonly active: WorkstreamDragItem;
  readonly over: WorkstreamDragItem;
  /** Every listed workstream in display order. */
  readonly entries: ReadonlyArray<WorkstreamEntry>;
  readonly manualOrder: boolean;
}): ReadonlyArray<WorkstreamMutation> {
  const { active, over, entries } = input;
  if (active.kind === "unsorted") return [];
  if (active.kind === "workstream") {
    if (
      !input.manualOrder ||
      over.kind !== "workstream" ||
      over.environmentId !== active.environmentId ||
      over.workstreamId === active.workstreamId
    ) {
      return [];
    }
    const siblings = entries.filter(
      (entry) => entry.workstream.environmentId === active.environmentId,
    );
    return planPinnedReorder({
      orderedIds: moveBefore(
        siblings.map((entry) => entry.workstream.id),
        active.workstreamId,
        over.workstreamId,
      ),
      keysById: new Map(siblings.map((entry) => [entry.workstream.id, entry.workstream.orderKey])),
      movedId: active.workstreamId,
    }).map((write) => ({
      type: "workstream.update",
      workstreamId: write.id as WorkstreamId,
      orderKey: write.orderKey,
    }));
  }
  const containing = (threadId: ThreadId) =>
    entries.find(
      (entry) =>
        entry.workstream.environmentId === active.environmentId &&
        entry.threads.some((member) => member.thread.id === threadId),
    ) ?? null;
  const source = containing(active.threadId);
  if (over.kind === "unsorted") {
    return source === null
      ? []
      : [{ type: "thread.assign", threadId: active.threadId, workstreamId: null }];
  }
  if (over.environmentId !== active.environmentId) return [];
  // A pinned row of another workstream stands for that workstream.
  const target = over.kind === "thread" ? containing(over.threadId) : null;
  const targetId = over.kind === "workstream" ? over.workstreamId : target?.workstream.id;
  if (targetId === undefined) return [];
  if (targetId !== source?.workstream.id) {
    return [{ type: "thread.assign", threadId: active.threadId, workstreamId: targetId }];
  }
  if (over.kind !== "thread" || over.threadId === active.threadId) return [];
  const pinned = source.threads.filter((member) => member.pinned);
  if (
    !pinned.some((member) => member.thread.id === active.threadId) ||
    !pinned.some((member) => member.thread.id === over.threadId)
  ) {
    return [];
  }
  return planPinnedReorder({
    orderedIds: moveBefore(
      pinned.map((member) => member.thread.id),
      active.threadId,
      over.threadId,
    ),
    keysById: new Map(pinned.map((member) => [member.thread.id, member.pinOrderKey])),
    movedId: active.threadId,
  }).map((write) => ({
    type: "thread.pin",
    threadId: write.id as ThreadId,
    pinned: true,
    orderKey: write.orderKey,
  }));
}
