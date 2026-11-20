import { EnvironmentId, ThreadId, WorkstreamId } from "@t3tools/contracts";
import { generateSpreadPinOrderKeys } from "@t3tools/shared/pinOrderKey";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadSummary } from "../../types";
import type { WorkstreamEntry } from "./workstreamData";
import {
  isUnsortedCollapsed,
  parseWorkstreamDragId,
  planWorkstreamDrop,
  threadDragId,
  UNSORTED_DROP_ID,
  unsortedCollapseChange,
  workstreamDragId,
  type WorkstreamDragItem,
} from "./WorkstreamSidebar.logic";

const environmentId = EnvironmentId.make("env-a");
const otherEnvironmentId = EnvironmentId.make("env-b");

function entry(
  id: string,
  orderKey: string,
  threads: ReadonlyArray<readonly [id: string, pinOrderKey: string | null]>,
  ownerEnvironmentId = environmentId,
): WorkstreamEntry {
  return {
    workstream: {
      id: WorkstreamId.make(id),
      environmentId: ownerEnvironmentId,
      name: id,
      orderKey,
      defaultProjectId: null,
      memory: { enabled: true, instructions: "", budgetChars: 6_000 },
      createdAt: "2026-03-09T10:00:00.000Z",
      updatedAt: "2026-03-09T10:00:00.000Z",
    },
    threads: threads.map(([threadId, pinOrderKey]) => ({
      thread: { id: ThreadId.make(threadId) } as SidebarThreadSummary,
      pinned: pinOrderKey !== null,
      pinOrderKey,
      activityAt: null,
    })),
    lastActiveThread: null,
    lastActivityAt: null,
  };
}

const [first, second, third] = generateSpreadPinOrderKeys(3) as [string, string, string];
const entries = [
  entry("ws-1", first, [
    ["t1", first],
    ["t2", second],
    ["t3", null],
  ]),
  entry("ws-2", second, [["t4", first]]),
  entry("ws-3", third, []),
  entry("ws-other", first, [], otherEnvironmentId),
];

const thread = (id: string, owner = environmentId): WorkstreamDragItem => ({
  kind: "thread",
  environmentId: owner,
  threadId: ThreadId.make(id),
});
const workstream = (id: string, owner = environmentId): WorkstreamDragItem => ({
  kind: "workstream",
  environmentId: owner,
  workstreamId: WorkstreamId.make(id),
});
const plan = (active: WorkstreamDragItem, over: WorkstreamDragItem, manualOrder = true) =>
  planWorkstreamDrop({ active, over, entries, manualOrder });

describe("planWorkstreamDrop", () => {
  it("moves a thread onto another workstream, its pinned rows included", () => {
    const assign = { type: "thread.assign", threadId: "t3", workstreamId: "ws-2" };
    expect(plan(thread("t3"), workstream("ws-2"))).toEqual([assign]);
    expect(plan(thread("t3"), thread("t4"))).toEqual([assign]);
    expect(plan(thread("unsorted"), workstream("ws-3"))).toEqual([
      { type: "thread.assign", threadId: "unsorted", workstreamId: "ws-3" },
    ]);
  });

  it("removes a member dropped on the unsorted section and ignores one that is already there", () => {
    expect(plan(thread("t3"), { kind: "unsorted" })).toEqual([
      { type: "thread.assign", threadId: "t3", workstreamId: null },
    ]);
    expect(plan(thread("unsorted"), { kind: "unsorted" })).toEqual([]);
  });

  it("changes nothing for a drop on its own workstream or another environment", () => {
    expect(plan(thread("t3"), workstream("ws-1"))).toEqual([]);
    expect(plan(thread("t3"), thread("t1"))).toEqual([]);
    expect(plan(thread("t3"), workstream("ws-other", otherEnvironmentId))).toEqual([]);
    expect(plan(workstream("ws-1"), workstream("ws-other", otherEnvironmentId))).toEqual([]);
  });

  it("reorders pinned threads with one key between the new neighbours", () => {
    const [write, ...rest] = plan(thread("t2"), thread("t1"));
    expect(rest).toEqual([]);
    expect(write).toMatchObject({ type: "thread.pin", threadId: "t2", pinned: true });
    expect(write?.type === "thread.pin" && write.orderKey! < first).toBe(true);
  });

  it("reorders workstreams only in manual order", () => {
    expect(plan(workstream("ws-3"), workstream("ws-1"), false)).toEqual([]);
    const [write, ...rest] = plan(workstream("ws-1"), workstream("ws-3"));
    expect(rest).toEqual([]);
    expect(write).toMatchObject({ type: "workstream.update", workstreamId: "ws-1" });
    expect(write?.type === "workstream.update" && write.orderKey! > third).toBe(true);
  });
});

describe("drag ids and the unsorted section", () => {
  it("round-trips drag ids", () => {
    expect(parseWorkstreamDragId(threadDragId(environmentId, ThreadId.make("t1")))).toEqual(
      thread("t1"),
    );
    expect(
      parseWorkstreamDragId(workstreamDragId(environmentId, WorkstreamId.make("ws-1"))),
    ).toEqual(workstream("ws-1"));
    expect(parseWorkstreamDragId(UNSORTED_DROP_ID)).toEqual({ kind: "unsorted" });
    expect(parseWorkstreamDragId("something else")).toBeNull();
  });

  it("starts a long unsorted section closed until the user chooses", () => {
    expect(isUnsortedCollapsed([], 3)).toBe(false);
    expect(isUnsortedCollapsed([], 30)).toBe(true);
    expect(isUnsortedCollapsed(unsortedCollapseChange(false).add, 30)).toBe(false);
    expect(isUnsortedCollapsed(unsortedCollapseChange(true).add, 3)).toBe(true);
  });
});
