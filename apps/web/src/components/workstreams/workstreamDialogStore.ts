import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

export interface NewWorkstreamRequest {
  /** Null lets the dialog pick among the environments that have workstreams. */
  readonly environmentId: EnvironmentId | null;
  /** A thread of `environmentId` to move into the new workstream. */
  readonly assignThreadId: ThreadId | null;
}

export const useWorkstreamDialogStore = create<{
  readonly newWorkstream: NewWorkstreamRequest | null;
}>(() => ({ newWorkstream: null }));

export function requestNewWorkstream(request: NewWorkstreamRequest) {
  useWorkstreamDialogStore.setState({ newWorkstream: request });
}

export function closeNewWorkstreamDialog() {
  useWorkstreamDialogStore.setState({ newWorkstream: null });
}
