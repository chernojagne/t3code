import { useGT } from "gt-react";
import { LayersIcon, MessagesSquareIcon } from "lucide-react";

import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useWorkstreamsAvailable } from "./workstreamData";
import { toggleSidebarViewPreference, useSidebarViewPreference } from "./workstreamView";

/** Footer button that swaps the sidebar between threads and workstreams. */
export function WorkstreamViewToggle() {
  const gt = useGT();
  const available = useWorkstreamsAvailable();
  const view = useSidebarViewPreference();
  if (!available) return null;
  const label = view === "workstreams" ? gt("Show threads") : gt("Show workstreams");
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              data-testid="sidebar-view-toggle"
              onClick={toggleSidebarViewPreference}
              size="icon"
            >
              {view === "workstreams" ? <MessagesSquareIcon /> : <LayersIcon />}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
