import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useGT } from "gt-react";
import { LayersIcon, MessagesSquareIcon, PlusIcon } from "lucide-react";

import { TOGGLE_WORKSTREAMS_COMMAND } from "../../shortcuts/workstreamCommands";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../CommandPalette.logic";
import { useWorkstreamMutation } from "./useWorkstreamMutation";
import {
  useWorkstreamEditableEnvironmentIds,
  useWorkstreamsAvailable,
  useWorkstreamStates,
} from "./workstreamData";
import { requestNewWorkstream } from "./workstreamDialogStore";
import { toggleSidebarViewPreference, useSidebarViewPreference } from "./workstreamView";

const MOVE_GROUP = "workstreams:move";

/** Workstream commands for the palette; empty while no environment has workstreams. */
export function useWorkstreamPaletteItems(
  activeThread: Pick<EnvironmentThreadShell, "environmentId" | "id"> | null,
): ReadonlyArray<CommandPaletteActionItem | CommandPaletteSubmenuItem> {
  const gt = useGT();
  const available = useWorkstreamsAvailable();
  const view = useSidebarViewPreference();
  const states = useWorkstreamStates();
  const editable = useWorkstreamEditableEnvironmentIds();
  const runMutation = useWorkstreamMutation();
  if (!available) return [];

  const items: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
    {
      kind: "action",
      value: "action:toggle-workstreams",
      searchTerms: ["workstreams", "workstream", "threads", "sidebar", "view", "group", "switch"],
      title: view === "workstreams" ? gt("Show threads") : gt("Show workstreams"),
      icon:
        view === "workstreams" ? (
          <MessagesSquareIcon className={ITEM_ICON_CLASS} />
        ) : (
          <LayersIcon className={ITEM_ICON_CLASS} />
        ),
      shortcutCommand: TOGGLE_WORKSTREAMS_COMMAND,
      run: async () => toggleSidebarViewPreference(),
    },
  ];
  if (editable.size > 0) {
    items.push({
      kind: "action",
      value: "action:new-workstream",
      searchTerms: ["workstream", "new", "create", "group"],
      title: gt("New workstream"),
      icon: <PlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => requestNewWorkstream({ environmentId: null, assignThreadId: null }),
    });
  }

  const environment = activeThread
    ? states.find((entry) => entry.environmentId === activeThread.environmentId)
    : undefined;
  const serverState = environment?.serverState ?? null;
  if (
    !activeThread ||
    !environment ||
    !environment.state ||
    !editable.has(activeThread.environmentId)
  ) {
    return items;
  }
  const { environmentId, id: threadId } = activeThread;
  const currentId =
    environment.state.memberships.find((membership) => membership.threadId === threadId)
      ?.workstreamId ?? null;
  const moveItems: CommandPaletteActionItem[] = [
    ...environment.state.workstreams
      .toSorted((left, right) => left.name.localeCompare(right.name))
      .map((workstream) => ({
        kind: "action" as const,
        value: `workstream-move:${workstream.id}`,
        searchTerms: [workstream.name],
        title: workstream.name,
        ...(workstream.id === currentId
          ? { description: gt("Current workstream"), checked: true }
          : {}),
        icon: <LayersIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          if (workstream.id === currentId) return;
          await runMutation(
            environmentId,
            { type: "thread.assign", threadId, workstreamId: workstream.id },
            serverState,
          );
        },
      })),
    {
      kind: "action",
      value: "workstream-move:unsorted",
      searchTerms: ["unsorted", "none", "remove"],
      title: gt("Unsorted", { $context: "removes the thread from its workstream" }),
      ...(currentId === null ? { checked: true } : {}),
      icon: <MessagesSquareIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        if (currentId === null) return;
        await runMutation(
          environmentId,
          { type: "thread.assign", threadId, workstreamId: null },
          serverState,
        );
      },
    },
    {
      kind: "action",
      value: "workstream-move:new",
      searchTerms: ["new", "create", "workstream"],
      title: gt("New workstream…"),
      icon: <PlusIcon className={ITEM_ICON_CLASS} />,
      run: async () => requestNewWorkstream({ environmentId, assignThreadId: threadId }),
    },
  ];
  items.push({
    kind: "submenu",
    value: "action:move-thread-to-workstream",
    searchTerms: ["workstream", "move", "assign", "group", "thread"],
    title: gt("Move thread to workstream…"),
    icon: <LayersIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <LayersIcon className={ADDON_ICON_CLASS} />,
    groups: [{ value: MOVE_GROUP, label: gt("Workstreams"), items: moveItems }],
  });
  return items;
}
