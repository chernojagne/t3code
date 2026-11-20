import { wantedWorkstreamMemberPages } from "@t3tools/client-runtime/state/workstream-list";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useOlderSettledShelf } from "../../state/olderSettledShelf";
import type { SidebarThreadSummary } from "../../types";

/**
 * Reads older settled threads until every workstream member has a shell, and further while the
 * unsorted section is asked for more rows than are loaded. Shells leave older settled threads
 * out, so without this they never show after a reconnect. Nothing is read with neither reason.
 */
export function useWorkstreamMemberPages(input: {
  /** Every environment that lists workstreams; a stable list keeps the pages already read. */
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly missingByEnvironment: ReadonlyMap<EnvironmentId, number>;
  readonly unsortedWantsRows: boolean;
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
    unsortedWantsRows: input.unsortedWantsRows,
  });
  const { grow, pages } = shelf;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- requests more older settled pages while a workstream member or a requested unsorted row is not loaded
  useEffect(() => {
    if (wanted !== pages) grow(wanted);
  }, [wanted, pages, grow]);

  const isExhausted = (environmentId: EnvironmentId) => {
    const environment = shelf.environments.get(environmentId);
    if (!environment || environment.older === null) return true;
    return environment.pages.status === "ready" && environment.pages.frontier === null;
  };
  return {
    loading: shelf.loading,
    failed: shelf.failed,
    retry: shelf.retry,
    /** True once no page is left to read there, so a member still missing has no thread. */
    isExhausted,
    hasUnreadPages: input.environmentIds.some((environmentId) => !isExhausted(environmentId)),
    /** Older settled threads these environments hold that are not loaded, members included. */
    unloadedCount: (listedThreads: ReadonlyArray<SidebarThreadSummary>) =>
      shelf.unloadedCount(listedThreads),
  };
}
