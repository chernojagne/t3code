import { createFileRoute } from "@tanstack/react-router";

import { WorkstreamSettings } from "../components/workstreams/WorkstreamSettings";
import { validateWorkstreamSettingsSearch } from "../components/workstreams/workstreamSettings.logic";

function SettingsWorkstreamsRoute() {
  const target = Route.useSearch();
  return <WorkstreamSettings {...target} />;
}

export const Route = createFileRoute("/_chat/settings/workstreams")({
  validateSearch: validateWorkstreamSettingsSearch,
  component: SettingsWorkstreamsRoute,
});
