import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { workstreamStalenessBucket } from "@t3tools/client-runtime/state/workstream-list";
import type { ContextMenuSource, WorkstreamColor, WorkstreamIcon } from "@t3tools/contracts";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { ChevronDownIcon, EllipsisIcon, SquarePenIcon } from "lucide-react";
import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { contextMenuSourceOf } from "../../contextMenuSource";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { MessageResolver } from "../../i18n/messages";
import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { formatRelativeTime } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { resolveSidebarFolderDot, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { WorkstreamEntry } from "./workstreamData";
import { parseWorkstreamDragId, workstreamDragId } from "./WorkstreamSidebar.logic";
import { WorkstreamIconPicker } from "./WorkstreamIcon";

function compactTimeLabel(timestamp: string, nowMs: number, resolve: MessageResolver) {
  const parts = formatRelativeTime(timestamp, nowMs, resolve);
  if (parts === null) return "";
  return parts.suffix === null ? resolve(msg("now", { $context: "relative time" })) : parts.value;
}

/** Subscribes to the minute tick itself, so only the label re-renders each minute. */
function WorkstreamRelativeTime(props: { timestamp: string | null }) {
  const nowMinute = useNowMinute();
  const m = useMessages();
  return props.timestamp === null
    ? null
    : compactTimeLabel(props.timestamp, Date.parse(`${nowMinute}:00.000Z`), m);
}

const STATUS_DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-error",
  unread: "bg-success",
  working: "bg-info",
} as const;

const STATUS_DOT_LABEL = {
  attention: msg(", needs you", { $context: "workstream status, read after its name" }),
  failed: msg(", failed", { $context: "workstream status, read after its name" }),
  unread: msg(", done", { $context: "workstream status, read after its name" }),
  working: msg(", working", { $context: "workstream status, read after its name" }),
} as const;

/** A quiet workstream's dot fades with the age of its latest activity. */
const STALENESS_DOT_CLASS_NAME = {
  active: "bg-sidebar-foreground/60",
  today: "bg-sidebar-foreground/40",
  week: "bg-sidebar-foreground/25",
  older: "bg-sidebar-foreground/12",
  empty: "bg-transparent",
} as const;

/** A static dot for the most recently active thread: its status, else how stale it is. */
function WorkstreamStalenessDot(props: {
  thread: SidebarThreadSummary | null;
  lastActivityAt: string | null;
}) {
  const m = useMessages();
  const nowMinute = useNowMinute();
  const threadRef = props.thread
    ? scopeThreadRef(props.thread.environmentId, props.thread.id)
    : null;
  const thread = useThreadShell(threadRef) ?? props.thread;
  const localLastVisitedAt = useUiStateStore((state) =>
    threadRef ? state.threadLastVisitedAtById[scopedThreadKey(threadRef)] : undefined,
  );
  const status = thread
    ? resolveSidebarFolderDot([
        {
          ...thread,
          lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
        },
      ])
    : null;
  const bucket = workstreamStalenessBucket(
    props.lastActivityAt,
    Date.parse(`${nowMinute}:00.000Z`),
  );
  return (
    <span
      data-workstream-staleness={status ?? bucket}
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status ? STATUS_DOT_CLASS_NAME[status] : STALENESS_DOT_CLASS_NAME[bucket],
      )}
    >
      {status ? <span className="sr-only">{m(STATUS_DOT_LABEL[status])}</span> : null}
    </span>
  );
}

// Mounted only while renaming, so each rename starts from the saved name.
function WorkstreamRenameInput(props: {
  name: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const gt = useGT();
  const [name, setName] = useState(props.name);
  // Enter and Escape blur the input as it unmounts; that blur must not commit again.
  const settledRef = useRef(false);
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      settledRef.current = true;
      props.onCommit(name);
    } else if (event.key === "Escape") {
      event.preventDefault();
      settledRef.current = true;
      props.onCancel();
    }
  };
  return (
    <input
      autoFocus
      value={name}
      dir="auto"
      aria-label={gt("Workstream name")}
      onChange={(event) => setName(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        if (!settledRef.current) props.onCommit(name);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      className="-mx-1 min-w-0 flex-1 rounded-sm bg-card px-1 text-sm font-medium text-card-foreground outline-none ring-1 ring-inset ring-input focus:ring-foreground"
    />
  );
}

const SORT_DISABLED = { draggable: true, droppable: false } as const;
const SORT_ENABLED = { draggable: false, droppable: false } as const;

/**
 * One workstream: a header that folds its threads, and the threads as children. The whole
 * section is the drop target, so a thread dropped anywhere on it joins the workstream.
 */
export function WorkstreamRow(props: {
  entry: WorkstreamEntry;
  /** Listed threads plus members whose older settled shell is still being read. */
  threadCount: number;
  collapsed: boolean;
  /** Set when more than one environment lists workstreams. */
  environmentLabel: string | null;
  canMutate: boolean;
  reorderable: boolean;
  isRenaming: boolean;
  onToggle: (entry: WorkstreamEntry) => void;
  onNewThread: (entry: WorkstreamEntry) => void;
  onContextMenu: (
    entry: WorkstreamEntry,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
  onCommitRename: (entry: WorkstreamEntry, name: string) => void;
  onCancelRename: () => void;
  onAppearanceChange: (
    entry: WorkstreamEntry,
    change: { icon?: WorkstreamIcon; color?: WorkstreamColor },
  ) => void;
  children: ReactNode;
}) {
  const gt = useGT();
  const { entry, collapsed } = props;
  const { workstream } = entry;
  const { setNodeRef, listeners, transform, transition, isDragging, isOver, active } = useSortable({
    id: workstreamDragId(workstream.environmentId, workstream.id),
    disabled:
      props.reorderable && props.canMutate && !props.isRenaming ? SORT_ENABLED : SORT_DISABLED,
  });
  const activeDrag = active ? parseWorkstreamDragId(active.id) : null;
  const acceptsDrop =
    isOver &&
    activeDrag?.kind === "thread" &&
    activeDrag.environmentId === workstream.environmentId &&
    !entry.threads.some((member) => member.thread.id === activeDrag.threadId);
  const openMenu = (event: ReactMouseEvent, position: { x: number; y: number }) => {
    event.preventDefault();
    props.onContextMenu(entry, position, contextMenuSourceOf(event));
  };
  const count = props.threadCount;
  return (
    <li
      ref={setNodeRef}
      data-testid="workstream-row"
      className={cn(
        "group/workstream relative mt-1 list-none rounded-(--control-radius) first:mt-0",
        isDragging && "z-10 opacity-80",
        acceptsDrop && "bg-sidebar-row-hover ring-1 ring-inset ring-primary/60",
      )}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div
        className="relative"
        onContextMenu={(event) => openMenu(event, { x: event.clientX, y: event.clientY })}
      >
        {/* Outside the toggle: a button cannot hold the picker's own button. */}
        <span className="absolute top-1 left-1.5 z-[1]">
          <WorkstreamIconPicker
            name={workstream.name}
            icon={workstream.icon}
            color={workstream.color}
            disabled={!props.canMutate}
            onChange={(change) => props.onAppearanceChange(entry, change)}
          />
        </span>
        {props.isRenaming ? (
          <div className="flex h-8 items-center gap-2.5 ps-9.5 pe-(--sidebar-row-content-inset)">
            <WorkstreamRenameInput
              name={workstream.name}
              onCommit={(name) => props.onCommitRename(entry, name)}
              onCancel={props.onCancelRename}
            />
          </div>
        ) : (
          <button
            type="button"
            aria-expanded={!collapsed}
            {...listeners}
            onClick={() => props.onToggle(entry)}
            className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-(--control-radius) ps-9.5 pe-(--sidebar-row-content-inset) text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <span
              dir="auto"
              className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground/90"
            >
              {workstream.name}
            </span>
            {props.environmentLabel ? (
              <Badge size="sm" variant="outline">
                {props.environmentLabel}
              </Badge>
            ) : null}
            <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-sidebar-muted-foreground group-hover/workstream:invisible group-has-[[data-workstream-action]:focus]/workstream:invisible pointer-coarse:invisible">
              <WorkstreamStalenessDot
                thread={entry.lastActiveThread}
                lastActivityAt={entry.lastActivityAt}
              />
              <WorkstreamRelativeTime timestamp={entry.lastActivityAt} />
              <span
                aria-label={gt("{count, plural, one {{count} thread} other {{count} threads}}", {
                  count,
                })}
              >
                {count}
              </span>
            </span>
            <ChevronDownIcon
              aria-hidden
              className={cn(
                "size-3 shrink-0 text-sidebar-muted-foreground transition-transform",
                collapsed && "-rotate-90",
              )}
            />
          </button>
        )}
        {props.isRenaming ? null : (
          <span className="absolute inset-y-0 right-6 flex items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/workstream:opacity-100 pointer-coarse:opacity-100">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    data-workstream-action=""
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={!props.canMutate}
                    aria-label={gt("New thread in {workstream}", { workstream: workstream.name })}
                    onClick={() => props.onNewThread(entry)}
                  />
                }
              >
                <SquarePenIcon aria-hidden />
              </TooltipTrigger>
              <TooltipPopup>
                <T>
                  New thread in <Var>{workstream.name}</Var>
                </T>
              </TooltipPopup>
            </Tooltip>
            <Button
              data-workstream-action=""
              size="icon-xs"
              variant="ghost-muted"
              aria-label={gt("Actions for {workstream}", { workstream: workstream.name })}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                openMenu(event, { x: rect.left, y: rect.bottom });
              }}
            >
              <EllipsisIcon aria-hidden />
            </Button>
          </span>
        )}
      </div>
      {collapsed ? null : <ul className="flex flex-col ps-5">{props.children}</ul>}
    </li>
  );
}
