import type {
  Workstream,
  WorkstreamMembership,
  WorkstreamMutation,
  WorkstreamState,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";
import { resolveThreadActivityTimestamp, toSortableTimestamp } from "./threadSort.ts";

export type WorkstreamSortMode = "name" | "staleness" | "manual";

export type WorkstreamStalenessBucket = "active" | "today" | "week" | "older" | "empty";

type WorkstreamListThreadInput = Pick<
  EnvironmentThreadShell,
  "id" | "latestUserMessageAt" | "latestRun" | "updatedAt"
>;

export interface WorkstreamListThread<T> {
  readonly thread: T;
  readonly pinned: boolean;
  readonly pinOrderKey: string | null;
  readonly activityAt: string | null;
}

export interface WorkstreamListEntry<T, W extends Workstream = Workstream> {
  readonly workstream: W;
  /** Pinned threads first in their manual order, then the rest by latest activity. */
  readonly threads: ReadonlyArray<WorkstreamListThread<T>>;
  /** The thread that was active most recently, and when. Null for an empty workstream. */
  readonly lastActiveThread: T | null;
  readonly lastActivityAt: string | null;
}

export interface WorkstreamListModel<T, W extends Workstream = Workstream> {
  readonly workstreams: ReadonlyArray<WorkstreamListEntry<T, W>>;
  /** Threads in no workstream, by latest activity. */
  readonly unsorted: ReadonlyArray<T>;
}

const activityMs = (activityAt: string | null) =>
  activityAt === null ? Number.NEGATIVE_INFINITY : (toSortableTimestamp(activityAt) ?? 0);

function compareByActivity<T extends { readonly id: string }>(
  left: { readonly thread: T; readonly activityAt: string | null },
  right: { readonly thread: T; readonly activityAt: string | null },
) {
  const delta = activityMs(right.activityAt) - activityMs(left.activityAt);
  return delta !== 0 ? delta : left.thread.id.localeCompare(right.thread.id);
}

function comparePinned<T extends { readonly id: string }>(
  left: WorkstreamListThread<T> & { readonly pinnedAt: string | null },
  right: WorkstreamListThread<T> & { readonly pinnedAt: string | null },
) {
  if (left.pinOrderKey !== null && right.pinOrderKey !== null) {
    if (left.pinOrderKey !== right.pinOrderKey) {
      return left.pinOrderKey < right.pinOrderKey ? -1 : 1;
    }
  } else if (left.pinOrderKey !== null || right.pinOrderKey !== null) {
    return left.pinOrderKey !== null ? -1 : 1;
  }
  const delta = activityMs(right.pinnedAt) - activityMs(left.pinnedAt);
  return delta !== 0 ? delta : left.thread.id.localeCompare(right.thread.id);
}

/**
 * One environment's workstreams with their threads, unsorted. A membership whose thread is not
 * in `threads` (archived, hidden or not loaded) is left out, and so is one naming a workstream
 * that no longer exists: that thread lists as unsorted.
 */
export function buildWorkstreamEntries<
  T extends WorkstreamListThreadInput,
  W extends Workstream = Workstream,
>(input: {
  readonly workstreams: ReadonlyArray<W>;
  readonly memberships: ReadonlyArray<WorkstreamMembership>;
  readonly threads: ReadonlyArray<T>;
}): WorkstreamListModel<T, W> {
  const membershipByThreadId = new Map(
    input.memberships.map((membership) => [membership.threadId, membership]),
  );
  const byWorkstreamId = new Map<
    string,
    Array<WorkstreamListThread<T> & { readonly pinnedAt: string | null }>
  >(input.workstreams.map((workstream) => [workstream.id, []]));
  const unsorted: Array<{ readonly thread: T; readonly activityAt: string | null }> = [];
  for (const thread of input.threads) {
    const activityAt = resolveThreadActivityTimestamp(thread);
    const membership = membershipByThreadId.get(thread.id);
    const members = membership ? byWorkstreamId.get(membership.workstreamId) : undefined;
    if (!membership || !members) {
      unsorted.push({ thread, activityAt });
      continue;
    }
    members.push({
      thread,
      activityAt,
      pinned: membership.pinnedAt !== null,
      pinOrderKey: membership.pinnedAt === null ? null : membership.pinOrderKey,
      pinnedAt: membership.pinnedAt,
    });
  }
  return {
    workstreams: input.workstreams.map((workstream) => {
      const members = byWorkstreamId.get(workstream.id) ?? [];
      const byActivity = [...members].sort(compareByActivity);
      const latest = byActivity[0] ?? null;
      return {
        workstream,
        threads: [
          ...members.filter((member) => member.pinned).sort(comparePinned),
          ...byActivity.filter((member) => !member.pinned),
        ].map(({ thread, activityAt, pinned, pinOrderKey }) => ({
          thread,
          activityAt,
          pinned,
          pinOrderKey,
        })),
        lastActiveThread: latest?.thread ?? null,
        lastActivityAt: latest?.activityAt ?? null,
      };
    }),
    unsorted: unsorted.sort(compareByActivity).map((entry) => entry.thread),
  };
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Name order follows `locale`; staleness puts the most recently active first and empty last. */
export function sortWorkstreamEntries<T, W extends Workstream>(
  entries: ReadonlyArray<WorkstreamListEntry<T, W>>,
  sort: WorkstreamSortMode,
  locale?: string,
): Array<WorkstreamListEntry<T, W>> {
  const byName = (left: WorkstreamListEntry<T, W>, right: WorkstreamListEntry<T, W>) =>
    left.workstream.name.localeCompare(right.workstream.name, locale, { sensitivity: "base" }) ||
    compareText(left.workstream.id, right.workstream.id);
  if (sort === "name") return [...entries].sort(byName);
  if (sort === "manual") {
    return [...entries].sort(
      (left, right) =>
        compareText(left.workstream.orderKey, right.workstream.orderKey) || byName(left, right),
    );
  }
  return [...entries].sort((left, right) => {
    if ((left.threads.length === 0) !== (right.threads.length === 0)) {
      return left.threads.length === 0 ? 1 : -1;
    }
    return (
      activityMs(right.lastActivityAt) - activityMs(left.lastActivityAt) || byName(left, right)
    );
  });
}

export function buildWorkstreamList<
  T extends WorkstreamListThreadInput,
  W extends Workstream = Workstream,
>(input: {
  readonly workstreams: ReadonlyArray<W>;
  readonly memberships: ReadonlyArray<WorkstreamMembership>;
  readonly threads: ReadonlyArray<T>;
  readonly sort: WorkstreamSortMode;
  readonly locale?: string;
}): WorkstreamListModel<T, W> {
  const model = buildWorkstreamEntries(input);
  return {
    workstreams: sortWorkstreamEntries(model.workstreams, input.sort, input.locale),
    unsorted: model.unsorted,
  };
}

const HOUR_MS = 60 * 60 * 1_000;
const WORKSTREAM_ACTIVE_WINDOW_MS = HOUR_MS;

/** How stale a workstream is, from its latest thread activity. Null activity is `empty`. */
export function workstreamStalenessBucket(
  lastActivityAt: string | null,
  nowMs: number,
): WorkstreamStalenessBucket {
  const at = lastActivityAt === null ? null : toSortableTimestamp(lastActivityAt);
  if (at === null) return "empty";
  const age = nowMs - at;
  if (age < WORKSTREAM_ACTIVE_WINDOW_MS) return "active";
  if (age < 24 * HOUR_MS) return "today";
  if (age < 7 * 24 * HOUR_MS) return "week";
  return "older";
}

/**
 * What the server's next state will most likely be after `mutation`, to show before it answers.
 * Creates and memory settings are left to the server, which owns ids and defaults.
 */
export function applyWorkstreamMutation(
  state: WorkstreamState,
  mutation: WorkstreamMutation,
  now: string,
): WorkstreamState {
  switch (mutation.type) {
    case "workstream.update":
      return {
        ...state,
        workstreams: state.workstreams.map((workstream) =>
          workstream.id !== mutation.workstreamId
            ? workstream
            : {
                ...workstream,
                ...(mutation.name === undefined ? {} : { name: mutation.name }),
                ...(mutation.orderKey === undefined ? {} : { orderKey: mutation.orderKey }),
                ...(mutation.defaultProjectId === undefined
                  ? {}
                  : { defaultProjectId: mutation.defaultProjectId }),
              },
        ),
      };
    case "workstream.delete":
      return {
        ...state,
        workstreams: state.workstreams.filter(
          (workstream) => workstream.id !== mutation.workstreamId,
        ),
        memberships: state.memberships.filter(
          (membership) => membership.workstreamId !== mutation.workstreamId,
        ),
      };
    case "thread.assign": {
      const others = state.memberships.filter(
        (membership) => membership.threadId !== mutation.threadId,
      );
      return {
        ...state,
        memberships:
          mutation.workstreamId === null
            ? others
            : [
                ...others,
                {
                  threadId: mutation.threadId,
                  workstreamId: mutation.workstreamId,
                  pinnedAt: null,
                  pinOrderKey: null,
                },
              ],
      };
    }
    case "thread.pin":
      return {
        ...state,
        memberships: state.memberships.map((membership) =>
          membership.threadId !== mutation.threadId
            ? membership
            : mutation.pinned
              ? {
                  ...membership,
                  pinnedAt: membership.pinnedAt ?? now,
                  pinOrderKey: mutation.orderKey ?? membership.pinOrderKey,
                }
              : { ...membership, pinnedAt: null, pinOrderKey: null },
        ),
      };
    default:
      return state;
  }
}
