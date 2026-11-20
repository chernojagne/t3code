import type { WorkstreamSortMode } from "@t3tools/client-runtime/state/workstream-list";
import * as Schema from "effect/Schema";

import { useLocalStorage, writeLocalStorageValue } from "../../hooks/useLocalStorage";

const SIDEBAR_VIEW_STORAGE_KEY = "t3code:sidebar:view";
const WORKSTREAM_SORT_STORAGE_KEY = "t3code:workstreams:sort";
const WORKSTREAM_COLLAPSED_STORAGE_KEY = "t3code:workstreams:collapsed";

const SidebarView = Schema.Literals(["threads", "workstreams"]);
export type SidebarView = typeof SidebarView.Type;
const SortMode = Schema.Literals(["name", "staleness", "manual"]);
const CollapsedKeys = Schema.Array(Schema.String);

const DEFAULT_SIDEBAR_VIEW: SidebarView = "threads";
const DEFAULT_SORT_MODE: WorkstreamSortMode = "staleness";
const NO_COLLAPSED_KEYS: ReadonlyArray<string> = [];

/** Which sidebar this device shows. Workstreams still need an environment that has them. */
export function useSidebarViewPreference(): SidebarView {
  return useLocalStorage(SIDEBAR_VIEW_STORAGE_KEY, DEFAULT_SIDEBAR_VIEW, SidebarView)[0];
}

export function setSidebarViewPreference(view: SidebarView) {
  writeLocalStorageValue(SIDEBAR_VIEW_STORAGE_KEY, view, DEFAULT_SIDEBAR_VIEW, SidebarView);
}

export function toggleSidebarViewPreference() {
  writeLocalStorageValue(
    SIDEBAR_VIEW_STORAGE_KEY,
    (view) => (view === "workstreams" ? "threads" : "workstreams"),
    DEFAULT_SIDEBAR_VIEW,
    SidebarView,
  );
}

export function useWorkstreamSortMode() {
  return useLocalStorage(WORKSTREAM_SORT_STORAGE_KEY, DEFAULT_SORT_MODE, SortMode);
}

/** Row keys the user closed, plus the explicit open or closed choice for the unsorted section. */
export function useWorkstreamCollapsedKeys() {
  const [keys, setKeys] = useLocalStorage(
    WORKSTREAM_COLLAPSED_STORAGE_KEY,
    NO_COLLAPSED_KEYS,
    CollapsedKeys,
  );
  const replace = (remove: ReadonlyArray<string>, add: ReadonlyArray<string>) =>
    setKeys((current) => [...current.filter((key) => !remove.includes(key)), ...add]);
  return { keys, replace };
}
