import { createWorkstreamEnvironmentAtoms } from "@t3tools/client-runtime/state/workstreams";

import { connectionAtomRuntime } from "../connection/runtime";

export const workstreamEnvironment = createWorkstreamEnvironmentAtoms(connectionAtomRuntime);
