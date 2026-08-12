import { createThreadQueueEnvironmentAtoms } from "@t3tools/client-runtime/state/threadQueue";

import { connectionAtomRuntime } from "../connection/runtime";

export const threadQueueEnvironment = createThreadQueueEnvironmentAtoms(connectionAtomRuntime);
