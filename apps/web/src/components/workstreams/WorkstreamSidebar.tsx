import {
  closestCenter,
  DndContext,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { useAtomValue } from "@effect/atom-react";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import {
  buildWorkstreamEntries,
  sortWorkstreamEntries,
  workstreamMemberCounts,
  type WorkstreamSortMode,
} from "@t3tools/client-runtime/state/workstream-list";
import type {
  ContextMenuItem,
  ContextMenuSource,
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  WorkstreamColor,
  WorkstreamIcon,
  WorkstreamId,
  WorkstreamState,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { msg, T, useGT, useLocale, useMessages } from "gt-react";
import {
  ArrowDownUpIcon,
  ChevronDownIcon,
  FolderPlusIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useClientSettings } from "../../hooks/useSettings";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import {
  readLastUsedProjectKey,
  resolveDefaultProjectRef,
  useNewThreadHandler,
} from "../../hooks/useHandleNewThread";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useDelegatedUnderParent, useProjects, useQuietThreadShells } from "../../state/entities";
import { useEnvironmentIdentities, useEnvironmentMachines } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { sidebarProviderEntriesAtom } from "../Sidebar";
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarFolderDrop } from "../sidebar/SidebarFolderDrop";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { SortableThreadRow, type SidebarProviderEntry } from "../sidebar/SidebarThreadRow";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SidebarContent, SidebarGroup, SidebarInput, useSidebar } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useWorkstreamMemberPages } from "./useWorkstreamMemberPages";
import { useWorkstreamMutation } from "./useWorkstreamMutation";
import {
  useWorkstreamEditableEnvironmentIds,
  useWorkstreamStates,
  workstreamKey,
  type EnvironmentWorkstream,
  type WorkstreamEntry,
} from "./workstreamData";
import { requestNewWorkstream } from "./workstreamDialogStore";
import { WorkstreamRow } from "./WorkstreamRow";
import {
  filterWorkstreamSearch,
  isUnsortedCollapsed,
  parseWorkstreamDragId,
  pinThreadMutation,
  planWorkstreamDrop,
  threadDragId,
  UNSORTED_DROP_ID,
  unsortedCollapseChange,
  workstreamDragId,
} from "./WorkstreamSidebar.logic";
import { WorkstreamThreadShortcuts } from "./WorkstreamThreadShortcuts";
import { useWorkstreamCollapsedKeys, useWorkstreamSortMode } from "./workstreamView";

const SORT_MODE_LABELS: Record<WorkstreamSortMode, string> = {
  name: msg("Name", { $context: "sort workstreams by name" }),
  staleness: msg("Staleness", { $context: "sort workstreams by latest activity" }),
  manual: msg("Manual", { $context: "sort workstreams in the order the user arranged" }),
};
const SORT_MODES = ["name", "staleness", "manual"] as const;

// The size of one older settled page, so one "Show more" is at most one read per environment.
const UNSORTED_PAGE_SIZE = 25;

const NO_PROVIDER_ENTRIES: ReadonlyMap<string, SidebarProviderEntry> = new Map();
// A project made from a workstream's menu becomes its default only this soon after the request.
const NEW_PROJECT_DEFAULT_WINDOW_MS = 10 * 60_000;
const noop = () => {};

interface PendingDefaultProject {
  readonly environmentId: EnvironmentId;
  readonly workstreamId: WorkstreamId;
  readonly knownProjectIds: ReadonlySet<string>;
  readonly requestedAt: number;
}

function requestDefaultProject(
  environmentId: EnvironmentId,
  workstreamId: WorkstreamId,
  knownProjectIds: ReadonlyArray<string>,
): PendingDefaultProject {
  return {
    environmentId,
    workstreamId,
    knownProjectIds: new Set(knownProjectIds),
    requestedAt: Date.now(),
  };
}

const isPendingDefaultProjectStale = (pending: PendingDefaultProject) =>
  Date.now() - pending.requestedAt > NEW_PROJECT_DEFAULT_WINDOW_MS;
const neverOpensPullRequestsInRightPanel = () => false;

// A dragged workstream only reorders among workstreams. A dragged thread lands on the section
// under the pointer; only a pinned thread over another pinned row lands on that row.
const makeCollisionDetection =
  (pinnedDragIds: ReadonlySet<string>): CollisionDetection =>
  (args) => {
    if (parseWorkstreamDragId(args.active.id)?.kind === "workstream") {
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter(
          (container) => parseWorkstreamDragId(container.id)?.kind === "workstream",
        ),
      });
    }
    const hits = pointerWithin(args);
    const row = pinnedDragIds.has(String(args.active.id))
      ? hits.find((hit) => pinnedDragIds.has(String(hit.id)))
      : undefined;
    return row ? [row] : hits.filter((hit) => parseWorkstreamDragId(hit.id)?.kind !== "thread");
  };

function UnsortedSection(props: {
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const { setNodeRef, isOver, active } = useDroppable({ id: UNSORTED_DROP_ID });
  const acceptsDrop = isOver && active !== null;
  return (
    <li
      ref={setNodeRef}
      data-testid="workstream-unsorted"
      className={cn(
        "mt-3 list-none rounded-(--control-radius)",
        acceptsDrop && "bg-sidebar-row-hover ring-1 ring-inset ring-primary/60",
      )}
    >
      <CollapsibleSectionHeader
        expanded={!props.collapsed}
        onClick={props.onToggle}
        accessory={<span className="font-normal tabular-nums">{props.count}</span>}
      >
        <T context="section of threads that are in no workstream">Unsorted</T>
      </CollapsibleSectionHeader>
      {props.collapsed ? null : <ul className="flex flex-col">{props.children}</ul>}
    </li>
  );
}

export default function WorkstreamSidebar() {
  const gt = useGT();
  const m = useMessages();
  const locale = useLocale();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const states = useWorkstreamStates();
  const editableEnvironmentIds = useWorkstreamEditableEnvironmentIds();
  const quietThreads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const projects = useProjects();
  const identities = useEnvironmentIdentities();
  const routeTarget = useThreadRouteTarget();
  const [sort, setSort] = useWorkstreamSortMode();
  const collapsedKeys = useWorkstreamCollapsedKeys();
  const runMutation = useWorkstreamMutation();
  const handleNewThread = useNewThreadHandler();
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  // Null until the user asks for more; only then may the unsorted section read older pages.
  const [unsortedRequested, setUnsortedRequested] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pendingDefaultProjectRef = useRef<PendingDefaultProject | null>(null);
  const providerEntriesByEnvironment = useAtomValue(sidebarProviderEntriesAtom);
  const projectGroups = useSidebarProjectGroups();
  const environmentMachineById = useEnvironmentMachines();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
  );

  const threads = filterSidebarV2VisibleThreads(quietThreads, null, delegatedUnderParent);
  const stateByEnvironment = new Map(states.map((entry) => [entry.environmentId, entry]));
  const memberCountsByEnvironment = new Map(
    states.flatMap((entry) =>
      entry.state === null
        ? []
        : [
            [
              entry.environmentId,
              workstreamMemberCounts({
                memberships: entry.state.memberships,
                loadedThreadIds: new Set(
                  quietThreads.flatMap((thread) =>
                    thread.environmentId === entry.environmentId ? [thread.id] : [],
                  ),
                ),
                listedThreadIds: new Set(
                  threads.flatMap((thread) =>
                    thread.environmentId === entry.environmentId ? [thread.id] : [],
                  ),
                ),
              }),
            ] as const,
          ],
    ),
  );
  const models = states.flatMap((entry) =>
    entry.state === null
      ? []
      : [
          buildWorkstreamEntries<SidebarThreadSummary, EnvironmentWorkstream>({
            workstreams: entry.state.workstreams.map((workstream) => ({
              ...workstream,
              environmentId: entry.environmentId,
            })),
            memberships: entry.state.memberships,
            threads: threads.filter((thread) => thread.environmentId === entry.environmentId),
          }),
        ],
  );
  const allEntries = sortWorkstreamEntries(
    models.flatMap((model) => model.workstreams),
    sort,
    locale,
  );
  // Threads of an environment without workstreams stay reachable here; one still loading its
  // workstreams is left out so its threads do not flash through this section.
  const allUnsorted = [
    ...models.flatMap((model) => model.unsorted),
    ...threads.filter((thread) => !stateByEnvironment.has(thread.environmentId)),
  ]
    .map((thread) => ({
      thread,
      at: Date.parse(resolveThreadActivityTimestamp(thread) ?? "") || 0,
    }))
    .toSorted((left, right) => right.at - left.at)
    .map((entry) => entry.thread);
  const searching = query.trim() !== "";
  const { entries, unsorted } = filterWorkstreamSearch({
    query,
    entries: allEntries,
    unsorted: allUnsorted,
  });
  const loading = states.some((entry) => entry.state === null && !entry.failed);
  const failed = states.some((entry) => entry.failed);
  const labelByEnvironment = new Map(
    identities.map((identity) => [identity.environmentId, identity.label]),
  );
  const showEnvironment = states.length > 1;
  const activeThreadKey =
    routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  // A search lists every loaded match, so it neither pages nor folds a section.
  const unsortedLimit = searching ? unsorted.length : (unsortedRequested ?? UNSORTED_PAGE_SIZE);
  const memberPages = useWorkstreamMemberPages({
    environmentIds: states.map((entry) => entry.environmentId),
    missingByEnvironment: new Map(
      [...memberCountsByEnvironment].map(([environmentId, counts]) => [
        environmentId,
        counts.missing,
      ]),
    ),
    // "Show more" saves the section as open, so the loaded count cannot fold it here.
    unsortedWantsRows:
      unsortedRequested !== null &&
      unsortedRequested > unsorted.length &&
      !isUnsortedCollapsed(collapsedKeys.keys, unsorted.length),
  });
  // The shelf counts every unloaded older thread; members still missing are not unsorted.
  const unsortedUnloaded = Math.max(
    0,
    memberPages.unloadedCount(threads) -
      [...memberCountsByEnvironment].reduce(
        (sum, [environmentId, counts]) =>
          sum + (memberPages.isExhausted(environmentId) ? 0 : counts.missing),
        0,
      ),
  );
  const unsortedTotal = searching ? unsorted.length : unsorted.length + unsortedUnloaded;
  const unsortedCollapsed = !searching && isUnsortedCollapsed(collapsedKeys.keys, unsortedTotal);
  const isCollapsed = (key: string) => !searching && collapsedKeys.keys.includes(key);
  const projectByKey = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );
  const projectDisplayNameByKey = new Map(
    projectGroups.flatMap((group) =>
      group.memberProjects.map(
        (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
      ),
    ),
  );
  const pinnedDragIds = new Set(
    entries.flatMap((entry) =>
      entry.threads.flatMap((member) =>
        member.pinned ? [threadDragId(entry.workstream.environmentId, member.thread.id)] : [],
      ),
    ),
  );
  const unsortedShown = Math.min(unsortedLimit, unsorted.length);
  const unsortedLoadingMore =
    unsortedRequested !== null && unsortedRequested > unsorted.length && memberPages.hasUnreadPages;
  const showMoreUnsorted = () => {
    const change = unsortedCollapseChange(false);
    collapsedKeys.replace(change.remove, change.add);
    setUnsortedRequested(unsortedShown + UNSORTED_PAGE_SIZE);
  };
  const serverStateOf = (environmentId: EnvironmentId): WorkstreamState | null =>
    stateByEnvironment.get(environmentId)?.serverState ?? null;
  const canMutate = (environmentId: EnvironmentId) => editableEnvironmentIds.has(environmentId);

  const openThread = (threadRef: ScopedThreadRef) => {
    if (isMobile) setOpenMobile(false);
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  };

  const openThreadFromRow = (_event: unknown, threadRef: ScopedThreadRef) => openThread(threadRef);

  const openNewWorkstream = () => {
    const [onlyEnvironment] = states;
    requestNewWorkstream({
      environmentId: states.length === 1 && onlyEnvironment ? onlyEnvironment.environmentId : null,
      assignThreadId: null,
    });
  };

  const toggleWorkstream = (entry: WorkstreamEntry) => {
    const key = workstreamKey(entry.workstream.environmentId, entry.workstream.id);
    collapsedKeys.replace([key], collapsedKeys.keys.includes(key) ? [] : [key]);
  };

  const commitRename = (entry: WorkstreamEntry, rawName: string) => {
    setRenamingKey(null);
    const name = rawName.trim();
    if (name === "" || name === entry.workstream.name) return;
    const { environmentId, id } = entry.workstream;
    void runMutation(
      environmentId,
      { type: "workstream.update", workstreamId: id, name },
      serverStateOf(environmentId),
    );
  };

  const changeAppearance = (
    entry: WorkstreamEntry,
    change: { icon?: WorkstreamIcon; color?: WorkstreamColor },
  ) => {
    const { environmentId, id } = entry.workstream;
    void runMutation(
      environmentId,
      { type: "workstream.update", workstreamId: id, ...change },
      serverStateOf(environmentId),
    );
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the project is created by the command palette, which reports nothing back; its arrival in the project list is the only signal.
  useEffect(() => {
    const pending = pendingDefaultProjectRef.current;
    if (pending === null) return;
    const created = projects.find(
      (project) =>
        project.environmentId === pending.environmentId &&
        project.archivedAt == null &&
        !pending.knownProjectIds.has(project.id),
    );
    if (created === undefined) return;
    pendingDefaultProjectRef.current = null;
    if (isPendingDefaultProjectStale(pending)) return;
    void runMutation(pending.environmentId, {
      type: "workstream.update",
      workstreamId: pending.workstreamId,
      defaultProjectId: created.id,
    });
  }, [projects, runMutation]);

  const newThreadInWorkstream = async (entry: WorkstreamEntry) => {
    const { environmentId, id, defaultProjectId } = entry.workstream;
    const environmentProjects = projects.filter(
      (project) => project.environmentId === environmentId && project.archivedAt == null,
    );
    const projectRef = environmentProjects.some((project) => project.id === defaultProjectId)
      ? scopeProjectRef(environmentId, defaultProjectId as ProjectId)
      : resolveDefaultProjectRef(
          environmentProjects,
          useUiStateStore.getState().projectOrder,
          readLastUsedProjectKey(),
        );
    if (projectRef === null) {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: gt("Add a project to start a thread"),
          description: gt("This workstream's environment has no project to start a thread in."),
        }),
      );
      return;
    }
    if (isMobile) setOpenMobile(false);
    const opened = await handleNewThread(projectRef);
    if (opened === null) return;
    void runMutation(environmentId, {
      type: "thread.assign",
      threadId: opened.threadId,
      workstreamId: id,
    });
  };

  const openWorkstreamMenu = async (
    entry: WorkstreamEntry,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const { environmentId, id, name, defaultProjectId } = entry.workstream;
    const editable = canMutate(environmentId);
    const environmentProjects = projects.filter(
      (project) =>
        project.environmentId === environmentId &&
        (project.archivedAt == null || project.id === defaultProjectId),
    );
    const items: ContextMenuItem[] = [
      { id: "new-thread", label: gt("New thread"), disabled: !editable },
      { id: "rename", label: gt("Rename"), disabled: !editable },
      {
        id: "default-project",
        label: gt("Default project"),
        disabled: !editable,
        children: [
          {
            id: "project:",
            label: gt("None", { $context: "no default project for the workstream" }),
            checked: defaultProjectId === null,
          },
          ...environmentProjects.map((project, index) => ({
            id: `project:${project.id}`,
            label: project.title,
            checked: project.id === defaultProjectId,
            separatorBefore: index === 0,
          })),
          { id: "new-project", label: gt("New project…"), separatorBefore: true },
        ],
      },
      { id: "memory", label: gt("Memory settings"), separatorBefore: true },
      {
        id: "delete",
        label: gt("Delete workstream"),
        destructive: true,
        disabled: !editable,
        separatorBefore: true,
      },
    ];
    const clicked = await settlePromise(() => api.contextMenu.show(items, position, source));
    if (clicked._tag !== "Success" || clicked.value === null) return;
    const action = clicked.value;
    if (action === "new-thread") {
      void newThreadInWorkstream(entry);
    } else if (action === "new-project") {
      pendingDefaultProjectRef.current = requestDefaultProject(
        environmentId,
        id,
        projects.flatMap((project) =>
          project.environmentId === environmentId ? [project.id] : [],
        ),
      );
      openCommandPalette({ open: "add-project" });
    } else if (action === "rename") {
      setRenamingKey(workstreamKey(environmentId, id));
    } else if (action === "memory") {
      if (isMobile) setOpenMobile(false);
      void router.navigate({
        to: "/settings/workstreams",
        search: { environmentId, workstream: id },
      });
    } else if (action === "delete") {
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            gt("Delete workstream “{name}”?", { name }),
            gt(
              "Its threads are kept and become unsorted. The workstream's shared memory is deleted.",
            ),
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag !== "Success" || !confirmed.value) return;
      void runMutation(
        environmentId,
        { type: "workstream.delete", workstreamId: id },
        serverStateOf(environmentId),
      );
    } else if (action.startsWith("project:")) {
      pendingDefaultProjectRef.current = null;
      const projectId = action.slice("project:".length);
      void runMutation(
        environmentId,
        {
          type: "workstream.update",
          workstreamId: id,
          defaultProjectId: projectId === "" ? null : (projectId as ProjectId),
        },
        serverStateOf(environmentId),
      );
    }
  };

  const openThreadMenu = async (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const { environmentId, threadId } = threadRef;
    const environmentState = stateByEnvironment.get(environmentId);
    const serverState = environmentState?.serverState ?? null;
    const membership =
      environmentState?.state?.memberships.find((entry) => entry.threadId === threadId) ?? null;
    const editable = canMutate(environmentId) && serverState !== null;
    const targets = allEntries.filter((entry) => entry.workstream.environmentId === environmentId);
    const items: ContextMenuItem[] = [
      { id: "open", label: gt("Open", { $context: "verb, opens the thread" }) },
      {
        id: "move",
        label: gt("Move to workstream"),
        disabled: !editable,
        separatorBefore: true,
        children: [
          ...targets.map((entry) => ({
            id: `move:${entry.workstream.id}`,
            label: entry.workstream.name,
            checked: entry.workstream.id === membership?.workstreamId,
          })),
          {
            id: "move:",
            label: gt("Unsorted", { $context: "removes the thread from its workstream" }),
            checked: membership === null,
            separatorBefore: targets.length > 0,
          },
          { id: "move-new", label: gt("New workstream…"), separatorBefore: true },
        ],
      },
      ...(membership === null
        ? []
        : [
            {
              id: "pin",
              label:
                membership.pinnedAt === null ? gt("Pin in workstream") : gt("Unpin in workstream"),
              disabled: !editable,
            },
          ]),
    ];
    const clicked = await settlePromise(() => api.contextMenu.show(items, position, source));
    if (clicked._tag !== "Success" || clicked.value === null) return;
    const action = clicked.value;
    if (action === "open") {
      openThread(scopeThreadRef(environmentId, threadId));
    } else if (action === "move-new") {
      requestNewWorkstream({ environmentId, assignThreadId: threadId });
    } else if (action === "pin" && serverState !== null && membership !== null) {
      void runMutation(
        environmentId,
        membership.pinnedAt === null
          ? pinThreadMutation(serverState, threadId)
          : { type: "thread.pin", threadId, pinned: false },
        serverState,
      );
    } else if (action.startsWith("move:")) {
      const workstreamId = action.slice("move:".length);
      if ((membership?.workstreamId ?? "") === workstreamId) return;
      void runMutation(
        environmentId,
        {
          type: "thread.assign",
          threadId,
          workstreamId: workstreamId === "" ? null : (workstreamId as WorkstreamId),
        },
        serverState,
      );
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const active = parseWorkstreamDragId(event.active.id);
    const over = event.over ? parseWorkstreamDragId(event.over.id) : null;
    if (active === null || over === null || active.kind === "unsorted") return;
    const serverState = serverStateOf(active.environmentId);
    for (const mutation of planWorkstreamDrop({
      active,
      over,
      entries: allEntries,
      manualOrder: sort === "manual",
    })) {
      void runMutation(active.environmentId, mutation, serverState);
    }
  };

  const listedThreadRefs = [
    ...entries.flatMap((entry) =>
      isCollapsed(workstreamKey(entry.workstream.environmentId, entry.workstream.id))
        ? []
        : entry.threads.map((member) => member.thread),
    ),
    ...(unsortedCollapsed ? [] : unsorted.slice(0, unsortedLimit)),
  ].map((thread) => scopeThreadRef(thread.environmentId, thread.id));

  const unpinInWorkstream = (threadRef: ScopedThreadRef) => {
    void runMutation(
      threadRef.environmentId,
      { type: "thread.pin", threadId: threadRef.threadId, pinned: false },
      serverStateOf(threadRef.environmentId),
    );
  };

  // The threads pane's own row, so a thread reads the same in both panes. Settling, snoozing
  // and renaming stay in the threads pane; here a pin is the workstream's.
  const renderThread = (thread: SidebarThreadSummary, pinned: boolean) => {
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const projectKey = `${thread.environmentId}:${thread.projectId}` as const;
    const settled = thread.settledAt != null;
    return (
      <SortableThreadRow
        key={threadKey}
        sortableId={threadDragId(thread.environmentId, thread.id)}
        contextDrag={false}
        sortableDisabled={!canMutate(thread.environmentId)}
        thread={thread}
        variant={settled ? "slim" : "card"}
        variantAction={settled ? "unsettle" : "settle"}
        settlementSupported={false}
        snoozeSupported={false}
        pinningSupported={canMutate(thread.environmentId)}
        isPinned={pinned}
        dropVerb={null}
        dragOverPinned={false}
        sweepAction={null}
        snoozeWakeLabelText={null}
        wokeAt={null}
        isActive={activeThreadKey === threadKey}
        isRouteThread={activeThreadKey === threadKey}
        readOpensPullRequestsInRightPanel={neverOpensPullRequestsInRightPanel}
        jumpLabel={null}
        currentEnvironmentId={null}
        environmentLabel={
          showEnvironment ? (labelByEnvironment.get(thread.environmentId) ?? null) : null
        }
        environmentMachine={environmentMachineById.get(thread.environmentId) ?? "server"}
        scratchMachineLabel={null}
        project={projectByKey.get(projectKey) ?? null}
        projectDisplayName={projectDisplayNameByKey.get(projectKey) ?? null}
        providerEntryByInstanceId={
          providerEntriesByEnvironment.get(thread.environmentId) ?? NO_PROVIDER_ENTRIES
        }
        timestampFormat={timestampFormat}
        onThreadClick={openThreadFromRow}
        onThreadActivate={openThread}
        onStartRename={noop}
        onRenameTitleChange={noop}
        onCommitRename={noop}
        onCancelRename={noop}
        isRenaming={false}
        renamingTitle=""
        onContextMenu={openThreadMenu}
        onSettle={noop}
        onActionSweepStart={noop}
        onUnsettle={noop}
        onSnooze={noop}
        onUnsnooze={noop}
        onUnpin={unpinInWorkstream}
        onAcknowledgeWoke={noop}
      />
    );
  };

  return (
    <SidebarFolderDrop>
      <WorkstreamThreadShortcuts
        threadRefs={listedThreadRefs}
        routeThreadRef={routeTarget?.kind === "server" ? routeTarget.threadRef : null}
        onOpen={openThread}
      />
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <div className="flex items-center gap-1">
              <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/70">
                <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
                <SidebarInput
                  ref={searchInputRef}
                  nativeInput
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && query !== "") {
                      event.preventDefault();
                      setQuery("");
                    }
                  }}
                  placeholder={gt("Search", { $context: "search field placeholder" })}
                  aria-label={gt("Search workstreams")}
                  className="min-w-0 flex-1"
                />
                {searching ? (
                  <Button
                    type="button"
                    size="icon-micro"
                    variant="ghost-muted"
                    className="shrink-0"
                    aria-label={gt("Clear workstream search")}
                    onClick={() => {
                      setQuery("");
                      searchInputRef.current?.focus();
                    }}
                  >
                    <XIcon className="size-3" />
                  </Button>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center">
                <Menu>
                  <MenuTrigger
                    render={
                      <SidebarHeaderIconButton
                        label={gt("Sort workstreams")}
                        tooltip={gt("Sort: {mode}", { mode: m(SORT_MODE_LABELS[sort]) })}
                      />
                    }
                  >
                    <ArrowDownUpIcon />
                  </MenuTrigger>
                  <MenuPopup align="end" side="bottom">
                    <MenuRadioGroup
                      value={sort}
                      onValueChange={(next) => setSort(next as WorkstreamSortMode)}
                    >
                      {SORT_MODES.map((mode) => (
                        <MenuRadioItem key={mode} value={mode} closeOnClick>
                          {m(SORT_MODE_LABELS[mode])}
                        </MenuRadioItem>
                      ))}
                    </MenuRadioGroup>
                  </MenuPopup>
                </Menu>
                <SidebarHeaderIconButton
                  label={gt("New workstream")}
                  disabled={editableEnvironmentIds.size === 0}
                  onClick={openNewWorkstream}
                >
                  <FolderPlusIcon />
                </SidebarHeaderIconButton>
              </div>
            </div>
          </SidebarGroup>
        }
      >
        <SidebarGroup>
          <DndContext
            sensors={sensors}
            collisionDetection={makeCollisionDetection(pinnedDragIds)}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={handleDragEnd}
          >
            <ul className="flex flex-col" data-testid="workstream-list">
              <SortableContext
                items={entries.map((entry) =>
                  workstreamDragId(entry.workstream.environmentId, entry.workstream.id),
                )}
                strategy={verticalListSortingStrategy}
              >
                {entries.map((entry) => {
                  const { environmentId, id } = entry.workstream;
                  const key = workstreamKey(environmentId, id);
                  const pinned = entry.threads.filter((member) => member.pinned);
                  // Members with no shell yet count until their environment has no page left.
                  const missing = memberPages.isExhausted(environmentId)
                    ? 0
                    : (memberCountsByEnvironment
                        .get(environmentId)
                        ?.missingByWorkstreamId.get(id) ?? 0);
                  return (
                    <WorkstreamRow
                      key={key}
                      entry={entry}
                      threadCount={entry.threads.length + missing}
                      collapsed={isCollapsed(key)}
                      environmentLabel={
                        showEnvironment ? (labelByEnvironment.get(environmentId) ?? null) : null
                      }
                      canMutate={canMutate(environmentId)}
                      reorderable={sort === "manual" && !searching}
                      isRenaming={renamingKey === key}
                      onToggle={toggleWorkstream}
                      onNewThread={newThreadInWorkstream}
                      onContextMenu={openWorkstreamMenu}
                      onCommitRename={commitRename}
                      onCancelRename={() => setRenamingKey(null)}
                      onAppearanceChange={changeAppearance}
                    >
                      <SortableContext
                        items={pinned.map((member) =>
                          threadDragId(environmentId, member.thread.id),
                        )}
                        strategy={verticalListSortingStrategy}
                      >
                        {pinned.map((member) => renderThread(member.thread, true))}
                      </SortableContext>
                      {entry.threads
                        .filter((member) => !member.pinned)
                        .map((member) => renderThread(member.thread, false))}
                      {missing > 0 ? (
                        <li className="list-none">
                          <button
                            type="button"
                            aria-disabled={!memberPages.failed}
                            onClick={() => {
                              if (memberPages.failed) memberPages.retry();
                            }}
                            className="flex h-8 w-full items-center rounded-(--control-radius) px-2.5 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover aria-disabled:cursor-default aria-disabled:hover:bg-transparent"
                          >
                            {memberPages.failed
                              ? gt("Could not load older threads. Retry")
                              : gt("Loading")}
                          </button>
                        </li>
                      ) : entry.threads.length === 0 ? (
                        <li className="list-none px-2.5 py-1.5 text-xs text-sidebar-muted-foreground">
                          <T>No threads yet. Drag one here or start a new one.</T>
                        </li>
                      ) : null}
                    </WorkstreamRow>
                  );
                })}
              </SortableContext>
              {searching && entries.length === 0 && unsorted.length === 0 ? (
                <li className="list-none px-2.5 py-3 text-sm text-sidebar-muted-foreground">
                  <T>No workstream or thread matches.</T>
                </li>
              ) : null}
              {entries.length === 0 && !searching ? (
                <li className="list-none px-2.5 py-3 text-sm text-sidebar-muted-foreground">
                  {loading ? (
                    <T>Loading workstreams…</T>
                  ) : failed ? (
                    <T>Could not load workstreams.</T>
                  ) : (
                    <div className="flex flex-col items-start gap-2">
                      <T>
                        Group the threads working on one feature, bug or investigation into a
                        workstream. They share its memory.
                      </T>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={editableEnvironmentIds.size === 0}
                        onClick={openNewWorkstream}
                      >
                        <PlusIcon aria-hidden />
                        <T>New workstream</T>
                      </Button>
                    </div>
                  )}
                </li>
              ) : null}
              {unsortedTotal > 0 ? (
                <UnsortedSection
                  count={unsortedTotal}
                  collapsed={unsortedCollapsed}
                  onToggle={() => {
                    const change = unsortedCollapseChange(!unsortedCollapsed);
                    collapsedKeys.replace(change.remove, change.add);
                  }}
                >
                  {unsorted.slice(0, unsortedLimit).map((thread) => renderThread(thread, false))}
                  {unsortedLoadingMore && (memberPages.loading || memberPages.failed) ? (
                    <li className="list-none">
                      <button
                        type="button"
                        aria-disabled={!memberPages.failed}
                        onClick={() => {
                          if (memberPages.failed) memberPages.retry();
                        }}
                        className="flex h-8 w-full items-center rounded-(--control-radius) px-2.5 text-left text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover aria-disabled:cursor-default aria-disabled:hover:bg-transparent"
                      >
                        {memberPages.failed
                          ? gt("Could not load older threads. Retry")
                          : gt("Loading")}
                      </button>
                    </li>
                  ) : !searching &&
                    (unsorted.length > unsortedLimit || memberPages.hasUnreadPages) ? (
                    <li className="list-none">
                      <button
                        type="button"
                        data-testid="workstream-unsorted-more"
                        onClick={showMoreUnsorted}
                        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) px-2.5 text-left text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                      >
                        <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
                        {gt("{count, plural, one {Show {count} more} other {Show {count} more}}", {
                          count:
                            unsortedTotal > unsortedShown
                              ? Math.min(unsortedTotal - unsortedShown, UNSORTED_PAGE_SIZE)
                              : UNSORTED_PAGE_SIZE,
                        })}
                      </button>
                    </li>
                  ) : null}
                </UnsortedSection>
              ) : null}
            </ul>
          </DndContext>
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </SidebarFolderDrop>
  );
}
