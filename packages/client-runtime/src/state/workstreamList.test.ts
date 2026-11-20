import {
  ThreadId,
  WorkstreamId,
  type Workstream,
  type WorkstreamMembership,
  type WorkstreamState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyWorkstreamMutation,
  buildWorkstreamList,
  workstreamStalenessBucket,
  type WorkstreamSortMode,
} from "./workstreamList.ts";

const at = (hour: number) => `2026-03-09T${String(hour).padStart(2, "0")}:00:00.000Z`;

function thread(id: string, activeAt: string) {
  return {
    id: ThreadId.make(id),
    latestUserMessageAt: activeAt,
    latestRun: null,
    updatedAt: activeAt,
  };
}

function workstream(id: string, name: string, orderKey: string): Workstream {
  return {
    id: WorkstreamId.make(id),
    name,
    orderKey,
    defaultProjectId: null,
    memory: { enabled: true, instructions: "", budgetChars: 6_000 },
    createdAt: at(1),
    updatedAt: at(1),
  };
}

function member(
  threadId: string,
  workstreamId: string,
  pin: { readonly pinnedAt: string; readonly pinOrderKey: string | null } | null = null,
): WorkstreamMembership {
  return {
    threadId: ThreadId.make(threadId),
    workstreamId: WorkstreamId.make(workstreamId),
    pinnedAt: pin?.pinnedAt ?? null,
    pinOrderKey: pin?.pinOrderKey ?? null,
  };
}

const workstreams = [
  workstream("ws-b", "beta", "a1"),
  workstream("ws-a", "Alpha", "a3"),
  workstream("ws-empty", "Aardvark", "a2"),
];
const threads = [
  thread("t1", at(3)),
  thread("t2", at(9)),
  thread("t3", at(5)),
  thread("t4", at(7)),
  thread("t5", at(8)),
  thread("t6", at(2)),
  thread("t7", at(6)),
];
const memberships = [
  member("t1", "ws-a"),
  member("t2", "ws-b"),
  member("t3", "ws-b", { pinnedAt: at(4), pinOrderKey: "a2" }),
  member("t4", "ws-b", { pinnedAt: at(5), pinOrderKey: "a1" }),
  member("t5", "ws-b", { pinnedAt: at(6), pinOrderKey: null }),
  member("t6", "ws-b"),
  member("t7", "ws-gone"),
  member("t-archived", "ws-a"),
];

const build = (sort: WorkstreamSortMode) =>
  buildWorkstreamList({ workstreams, memberships, threads, sort, locale: "en" });

describe("buildWorkstreamList", () => {
  it.each([
    ["name", ["ws-empty", "ws-a", "ws-b"]],
    ["staleness", ["ws-b", "ws-a", "ws-empty"]],
    ["manual", ["ws-b", "ws-empty", "ws-a"]],
  ] as const)("orders workstreams by %s", (sort, expected) => {
    expect(build(sort).workstreams.map((entry) => entry.workstream.id)).toEqual(expected);
  });

  it("lists pinned threads by key, then keyless pins, then the rest by activity", () => {
    const beta = build("name").workstreams.find((entry) => entry.workstream.id === "ws-b")!;
    expect(beta.threads.map((entry) => [entry.thread.id, entry.pinned])).toEqual([
      ["t4", true],
      ["t3", true],
      ["t5", true],
      ["t2", false],
      ["t6", false],
    ]);
  });

  it("takes staleness from the most recently active thread, pinned or not", () => {
    const [beta, alpha, empty] = build("staleness").workstreams;
    expect([beta!.lastActiveThread?.id, beta!.lastActivityAt]).toEqual(["t2", at(9)]);
    expect([alpha!.lastActiveThread?.id, alpha!.lastActivityAt]).toEqual(["t1", at(3)]);
    expect([empty!.lastActiveThread, empty!.lastActivityAt]).toEqual([null, null]);
  });

  it("leaves threads with no workstream, or a deleted one, unsorted by activity", () => {
    const model = buildWorkstreamList({
      workstreams,
      memberships,
      threads: [...threads, thread("t8", at(10))],
      sort: "name",
    });
    expect(model.unsorted.map((entry) => entry.id)).toEqual(["t8", "t7"]);
    expect(model.workstreams.flatMap((entry) => entry.threads).length).toBe(6);
  });
});

describe("workstreamStalenessBucket", () => {
  const now = Date.parse("2026-03-09T12:00:00.000Z");
  it.each([
    [null, "empty"],
    ["not a date", "empty"],
    ["2026-03-09T11:30:00.000Z", "active"],
    ["2026-03-09T02:00:00.000Z", "today"],
    ["2026-03-05T12:00:00.000Z", "week"],
    ["2026-02-01T12:00:00.000Z", "older"],
  ] as const)("puts %s in %s", (lastActivityAt, bucket) => {
    expect(workstreamStalenessBucket(lastActivityAt, now)).toBe(bucket);
  });
});

describe("applyWorkstreamMutation", () => {
  const state: WorkstreamState = {
    workstreams: [...workstreams],
    memberships: [...memberships],
    memoryConfig: {
      gateEnabled: true,
      gateThreshold: 0.3,
      gateKeyConfigured: false,
      mergeModelSelection: null,
    },
  };
  const membershipOf = (next: WorkstreamState, threadId: string) =>
    next.memberships.find((membership) => membership.threadId === threadId);

  it("moves a thread and clears its pin", () => {
    const next = applyWorkstreamMutation(
      state,
      {
        type: "thread.assign",
        threadId: ThreadId.make("t3"),
        workstreamId: WorkstreamId.make("ws-a"),
      },
      at(11),
    );
    expect(membershipOf(next, "t3")).toEqual(member("t3", "ws-a"));
    expect(
      membershipOf(
        applyWorkstreamMutation(
          state,
          { type: "thread.assign", threadId: ThreadId.make("t3"), workstreamId: null },
          at(11),
        ),
        "t3",
      ),
    ).toBeUndefined();
  });

  it("pins, reorders and unpins a member", () => {
    const pin = (threadId: string, pinned: boolean, orderKey?: string) =>
      applyWorkstreamMutation(
        state,
        {
          type: "thread.pin",
          threadId: ThreadId.make(threadId),
          pinned,
          ...(orderKey === undefined ? {} : { orderKey }),
        },
        at(11),
      );
    expect(membershipOf(pin("t2", true, "a0"), "t2")).toMatchObject({
      pinnedAt: at(11),
      pinOrderKey: "a0",
    });
    expect(membershipOf(pin("t3", true, "a9"), "t3")).toMatchObject({
      pinnedAt: at(4),
      pinOrderKey: "a9",
    });
    expect(membershipOf(pin("t3", false), "t3")).toMatchObject({
      pinnedAt: null,
      pinOrderKey: null,
    });
  });

  it("drops a deleted workstream with its memberships", () => {
    const next = applyWorkstreamMutation(
      state,
      { type: "workstream.delete", workstreamId: WorkstreamId.make("ws-b") },
      at(11),
    );
    expect(next.workstreams.map((entry) => entry.id)).toEqual(["ws-a", "ws-empty"]);
    expect(next.memberships.map((entry) => entry.threadId)).toEqual(["t1", "t7", "t-archived"]);
  });
});
