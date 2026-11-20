import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  resolveShortcutCommand,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../../keybindings";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { resolveAdjacentThreadId, threadShortcutContext } from "../Sidebar.logic";

/** Previous, next and jump-to-thread shortcuts over the rows the workstream list shows. */
export function WorkstreamThreadShortcuts(props: {
  readonly threadRefs: ReadonlyArray<ScopedThreadRef>;
  readonly routeThreadRef: ScopedThreadRef | null;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const { threadRefs, routeThreadRef, onOpen } = props;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  const onWindowKeyDown = useStableCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
      return;
    }
    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: threadShortcutContext(routeThreadRef),
    });
    const direction = threadTraversalDirectionFromCommand(command);
    const keys = threadRefs.map(scopedThreadKey);
    const targetKey =
      direction !== null
        ? resolveAdjacentThreadId({
            threadIds: keys,
            currentThreadId: routeThreadRef ? scopedThreadKey(routeThreadRef) : null,
            direction,
          })
        : (keys[threadJumpIndexFromCommand(command ?? "") ?? -1] ?? null);
    const target = targetKey === null ? undefined : threadRefs[keys.indexOf(targetKey)];
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    onOpen(target);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window keydown for thread navigation shortcuts
  useEffect(() => {
    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [onWindowKeyDown]);

  return null;
}
