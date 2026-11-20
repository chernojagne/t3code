import { useEffect } from "react";

import { installWorkstreamCommands } from "../../shortcuts/workstreamCommands";
import ThreadSidebar from "../Sidebar";
import type { SidebarRouteReveal } from "../sidebar/routeReveal";
import { NewWorkstreamDialog } from "./NewWorkstreamDialog";
import { useWorkstreamsAvailable } from "./workstreamData";
import WorkstreamSidebar from "./WorkstreamSidebar";
import { useSidebarViewPreference } from "./workstreamView";

/** The sidebar body: workstreams when this device asks for them and an environment has them. */
export function SidebarViewSwitch({ routeReveal }: { readonly routeReveal: SidebarRouteReveal }) {
  const view = useSidebarViewPreference();
  const available = useWorkstreamsAvailable();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the view toggle with the global shortcut dispatcher while an environment has workstreams
  useEffect(() => (available ? installWorkstreamCommands() : undefined), [available]);

  return (
    <>
      {view === "workstreams" && available ? (
        <WorkstreamSidebar />
      ) : (
        <ThreadSidebar routeReveal={routeReveal} />
      )}
      {available ? <NewWorkstreamDialog /> : null}
    </>
  );
}
