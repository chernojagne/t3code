import { WorkstreamId, WorkstreamMemoryEntryId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  isTurnWorthConsidering,
  makeTurnDigest,
  parseMergeReply,
  planMemoryOperations,
  selectMemoryDelivery,
} from "./WorkstreamMemory.ts";
import type { WorkstreamRecord, WorkstreamThreadRecord } from "./WorkstreamRepository.ts";
import { memoryEntry, messageItem, OTHER_THREAD, THREAD } from "./testkit.ts";

const WORKSTREAM = WorkstreamId.make("workstream:one");

const workstream = (overrides: Partial<WorkstreamRecord> = {}): WorkstreamRecord => ({
  id: WORKSTREAM,
  name: "Checkout rewrite" as WorkstreamRecord["name"],
  orderKey: "V",
  defaultProjectId: null,
  memory: { enabled: true, instructions: "", budgetChars: 6_000 },
  memoryRevision: 5,
  memoryRemovedRevision: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const membership = (overrides: Partial<WorkstreamThreadRecord> = {}): WorkstreamThreadRecord => ({
  threadId: THREAD,
  workstreamId: WORKSTREAM,
  pinnedAt: null,
  pinOrderKey: null,
  memoryRunId: null,
  deliveredProviderThreadId: null,
  deliveredRevision: 0,
  ...overrides,
});

describe("isTurnWorthConsidering", () => {
  const digest = (user: string, reply: string) =>
    makeTurnDigest([messageItem("user", user), messageItem("assistant", reply)]);
  const substantial = "We will keep the old endpoint until every client has moved. ".repeat(6);

  it.each([
    [
      "a finished turn with a real reply",
      "completed",
      "Which endpoint do we keep?",
      substantial,
      true,
    ],
    ["a run that did not finish", "interrupted", "Which endpoint do we keep?", substantial, false],
    ["a compaction turn", "completed", "/compact", substantial, false],
    ["a goal command", "completed", "/goal ship the rewrite", substantial, false],
    ["small talk with no work done", "completed", "thanks", "You're welcome.", false],
    ["a turn with no reply", "completed", "Which endpoint do we keep?", "", false],
  ])("%s", (_name, runStatus, user, reply, expected) => {
    assert.strictEqual(
      isTurnWorthConsidering({ runStatus, digest: digest(user, reply) }),
      expected,
    );
  });
});

describe("parseMergeReply", () => {
  it("reads operations from a fenced reply and drops malformed ones", () => {
    const reply = [
      "Here you go:",
      "```json",
      '[{"op":"add","kind":"decision","text":"Keep v1 until March."},',
      ' {"op":"add","kind":"gossip","text":"not a kind"},',
      ' {"op":"delete","id":"memory:a"}, 7]',
      "```",
    ].join("\n");
    assert.deepStrictEqual(parseMergeReply(reply), [
      { op: "add", kind: "decision", text: "Keep v1 until March." },
      { op: "delete", id: "memory:a" },
    ]);
    assert.deepStrictEqual(parseMergeReply("nothing to change"), []);
  });
});

describe("planMemoryOperations", () => {
  it("leaves locked and unknown entries alone and skips duplicate adds", () => {
    const entries = [
      memoryEntry(
        { id: "memory:locked", text: "Never touch the ledger table.", locked: true },
        WORKSTREAM,
      ),
      memoryEntry(
        { id: "memory:open", text: "Port the refund flow.", kind: "open_item" },
        WORKSTREAM,
      ),
    ];
    const operations = planMemoryOperations({
      entries,
      threadId: THREAD,
      ids: [WorkstreamMemoryEntryId.make("memory:new")],
      proposed: [
        { op: "delete", id: "memory:locked" },
        { op: "update", id: "memory:locked", text: "Touch the ledger table freely." },
        { op: "delete", id: "memory:missing" },
        { op: "add", kind: "open_item", text: "port the refund flow." },
        { op: "add", kind: "decision", text: "Refunds go through the new service." },
        { op: "delete", id: "memory:open" },
      ],
    });
    assert.deepStrictEqual(operations, [
      {
        op: "add",
        id: WorkstreamMemoryEntryId.make("memory:new"),
        kind: "decision",
        text: "Refunds go through the new service.",
        sourceThreadId: THREAD,
        locked: false,
      },
      { op: "delete", id: WorkstreamMemoryEntryId.make("memory:open"), ifRevision: 1 },
    ]);
  });
});

describe("selectMemoryDelivery", () => {
  const entries = [
    memoryEntry(
      { id: "memory:old", text: "Staging uses the eu-west cluster.", revision: 2 },
      WORKSTREAM,
    ),
    memoryEntry(
      { id: "memory:mine", text: "I renamed the flag.", revision: 5, sourceThreadId: THREAD },
      WORKSTREAM,
    ),
    memoryEntry(
      {
        id: "memory:theirs",
        text: "The flag ships dark until Monday.",
        kind: "decision",
        revision: 5,
        sourceThreadId: OTHER_THREAD,
      },
      WORKSTREAM,
    ),
  ];

  it("gives a provider thread that has seen nothing the whole memory", () => {
    const delivery = selectMemoryDelivery({
      workstream: workstream(),
      membership: membership(),
      entries,
      providerThreadId: "provider-thread:a",
    });
    assert.strictEqual(delivery.revision, 5);
    for (const entry of entries) assert.include(delivery.text, entry.text);
  });

  it("afterwards gives only what other sessions changed", () => {
    const delivery = selectMemoryDelivery({
      workstream: workstream(),
      membership: membership({
        deliveredProviderThreadId: "provider-thread:a",
        deliveredRevision: 4,
      }),
      entries,
      providerThreadId: "provider-thread:a",
    });
    assert.include(delivery.text, "The flag ships dark until Monday.");
    assert.notInclude(delivery.text, "I renamed the flag.");
    assert.notInclude(delivery.text, "Staging uses the eu-west cluster.");
  });

  it("replaces the session's copy after a removal, even when nothing is left", () => {
    const seen = membership({
      deliveredProviderThreadId: "provider-thread:a",
      deliveredRevision: 5,
    });
    const removed = workstream({ memoryRevision: 6, memoryRemovedRevision: 6 });
    const replaced = selectMemoryDelivery({
      workstream: removed,
      membership: seen,
      entries: entries.slice(0, 1),
      providerThreadId: "provider-thread:a",
    });
    assert.include(replaced.text, "replaces what you were given before");
    assert.include(replaced.text, "Staging uses the eu-west cluster.");
    assert.notInclude(replaced.text, "The flag ships dark until Monday.");
    assert.include(
      selectMemoryDelivery({
        workstream: removed,
        membership: seen,
        entries: [],
        providerThreadId: "provider-thread:a",
      }).text,
      "(empty)",
    );
  });

  it("starts over when the session moves to a new provider thread", () => {
    const delivery = selectMemoryDelivery({
      workstream: workstream(),
      membership: membership({
        deliveredProviderThreadId: "provider-thread:a",
        deliveredRevision: 5,
      }),
      entries,
      providerThreadId: "provider-thread:b",
    });
    assert.include(delivery.text, "Staging uses the eu-west cluster.");
  });

  it("gives nothing when it is up to date or memory is off", () => {
    const upToDate = membership({
      deliveredProviderThreadId: "provider-thread:a",
      deliveredRevision: 5,
    });
    assert.strictEqual(
      selectMemoryDelivery({
        workstream: workstream(),
        membership: upToDate,
        entries,
        providerThreadId: "provider-thread:a",
      }).text,
      "",
    );
    assert.strictEqual(
      selectMemoryDelivery({
        workstream: workstream({
          memory: { enabled: false, instructions: "", budgetChars: 6_000 },
        }),
        membership: membership(),
        entries,
        providerThreadId: "provider-thread:a",
      }).text,
      "",
    );
  });
});
