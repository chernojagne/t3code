import { wantedWorkstreamMemberPages } from "@t3tools/client-runtime/state/workstream-list";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useOlderSettledShelf } from "../../state/olderSettledShelf";

/**
 * Reads older settled threads until every workstream member has a shell. Shells leave older
 * settled threads out, so without this a workstream made of them looks empty after a reconnect.
 * Nothing is read while no member is missing.
 */
export function useWorkstreamMemberPages(input: {
  /** Every environment that lists workstreams; a stable list keeps the pages already read. */
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly missingByEnvironment: ReadonlyMap<EnvironmentId, number>;
}) {
  const shelf = useOlderSettledShelf({
    scopes: input.environmentIds.map((environmentId) => ({ environmentId, projectIds: null })),
    expanded: true,
    visibleCount: 0,
  });
  const wanted = wantedWorkstreamMemberPages({
    requested: shelf.pages,
    environments: shelf.environments,
    missingByEnvironment: input.missingByEnvironment,
  });
  const { grow, pages } = shelf;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests more older settled pages while a workstream member's shell is not loaded
  useEffect(() => {
    if (wanted !== pages) grow(wanted);
  }, [wanted, pages, grow]);

  return {
    loading: shelf.loading,
    failed: shelf.failed,
    retry: shelf.retry,
    /** True once no page is left to read there, so a member still missing has no thread. */
    isExhausted: (environmentId: EnvironmentId) => {
      const environment = shelf.environments.get(environmentId);
      if (!environment || environment.older === null) return true;
      return environment.pages.status === "ready" && environment.pages.frontier === null;
    },
  };
}
