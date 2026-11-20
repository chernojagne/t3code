import { useDraggable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { ContextMenuSource, ScopedThreadRef } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";
import { PinIcon } from "lucide-react";
import { memo } from "react";

import { contextMenuSourceOf } from "../../contextMenuSource";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { MessageResolver } from "../../i18n/messages";
import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { formatRelativeTime } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { resolveThreadLastVisitedAt, resolveThreadStatusPill } from "../Sidebar.logic";
import { threadDragId } from "./WorkstreamSidebar.logic";

function compactTimeLabel(timestamp: string, nowMs: number, resolve: MessageResolver) {
  const parts = formatRelativeTime(timestamp, nowMs, resolve);
  if (parts === null) return "";
  return parts.suffix === null ? resolve(msg("now", { $context: "relative time" })) : parts.value;
}

/** Subscribes to the minute tick itself, so only the label re-renders each minute. */
export function WorkstreamRelativeTime(props: { timestamp: string | null }) {
  const nowMinute = useNowMinute();
  const m = useMessages();
  return props.timestamp === null
    ? null
    : compactTimeLabel(props.timestamp, Date.parse(`${nowMinute}:00.000Z`), m);
}

interface WorkstreamThreadRowProps {
  readonly thread: SidebarThreadSummary;
  readonly pinned: boolean;
  readonly isActive: boolean;
  readonly dragDisabled: boolean;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
  readonly onContextMenu: (
    thread: SidebarThreadSummary,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
}

type DragBag = Pick<
  ReturnType<typeof useDraggable>,
  "setNodeRef" | "listeners" | "transform" | "isDragging"
>;

function ThreadRowView(props: WorkstreamThreadRowProps & DragBag) {
  const { thread: arranged, setNodeRef, listeners, transform, isDragging } = props;
  const gt = useGT();
  const m = useMessages();
  const threadRef = scopeThreadRef(arranged.environmentId, arranged.id);
  // The list is arranged from quiet shells; the live one re-renders only this row.
  const thread = useThreadShell(threadRef) ?? arranged;
  const localLastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const status = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
    },
  });
  const title = thread.title || gt("Untitled thread");
  return (
    <li
      ref={setNodeRef}
      className={cn("list-none", isDragging && "relative z-10 opacity-80")}
      style={{ transform: CSS.Translate.toString(transform) }}
    >
      <button
        type="button"
        data-testid="workstream-thread-row"
        aria-current={props.isActive ? "page" : undefined}
        {...listeners}
        onClick={() => props.onOpen(threadRef)}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onContextMenu(
            thread,
            { x: event.clientX, y: event.clientY },
            contextMenuSourceOf(event),
          );
        }}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-2 rounded-(--control-radius) py-0 pr-(--sidebar-row-content-inset) pl-8 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          props.isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-foreground/85 hover:bg-sidebar-row-hover",
        )}
      >
        <span
          aria-hidden={status === null}
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            status === null ? "bg-transparent" : status.dotClass,
          )}
        >
          {status === null ? null : <span className="sr-only">{m(status.label)}</span>}
        </span>
        <span dir="auto" className="min-w-0 flex-1 truncate">
          {title}
        </span>
        {props.pinned ? (
          <PinIcon
            aria-label={gt("Pinned in workstream")}
            className="size-3 shrink-0 text-sidebar-muted-foreground"
          />
        ) : null}
        <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
          <WorkstreamRelativeTime timestamp={resolveThreadActivityTimestamp(thread)} />
        </span>
      </button>
    </li>
  );
}

const DRAG_DISABLED = { draggable: true, droppable: false } as const;
const DRAG_ENABLED = { draggable: false, droppable: false } as const;

/** A pinned row: draggable within its workstream's pinned run, and onto other workstreams. */
export const PinnedWorkstreamThreadRow = memo(function PinnedWorkstreamThreadRow(
  props: WorkstreamThreadRowProps,
) {
  const { setNodeRef, listeners, transform, isDragging } = useSortable({
    id: threadDragId(props.thread.environmentId, props.thread.id),
    disabled: props.dragDisabled ? DRAG_DISABLED : DRAG_ENABLED,
  });
  return (
    <ThreadRowView
      {...props}
      setNodeRef={setNodeRef}
      listeners={listeners}
      transform={transform}
      isDragging={isDragging}
    />
  );
});

/** An unpinned or unsorted row: draggable onto a workstream, never a drop target itself. */
export const WorkstreamThreadRow = memo(function WorkstreamThreadRow(
  props: WorkstreamThreadRowProps,
) {
  const { setNodeRef, listeners, transform, isDragging } = useDraggable({
    id: threadDragId(props.thread.environmentId, props.thread.id),
    disabled: props.dragDisabled,
  });
  return (
    <ThreadRowView
      {...props}
      setNodeRef={setNodeRef}
      listeners={listeners}
      transform={transform}
      isDragging={isDragging}
    />
  );
});
