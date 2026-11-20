import type { KeybindingCommand } from "@t3tools/contracts";

import { toggleSidebarViewPreference } from "../components/workstreams/workstreamView";
import { registerCommands } from "./dispatcher";

export const TOGGLE_WORKSTREAMS_COMMAND: KeybindingCommand = "sidebar.toggleWorkstreams";

/** Switches the sidebar between threads and workstreams on its shortcut. */
export function installWorkstreamCommands(): () => void {
  return registerCommands({
    [TOGGLE_WORKSTREAMS_COMMAND]: (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) toggleSidebarViewPreference();
    },
  });
}
