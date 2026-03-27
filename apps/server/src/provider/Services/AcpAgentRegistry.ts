import type { AcpAgentServer, ServerAcpAgentStatus } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface AcpAgentRegistryShape {
  readonly listStatuses: Effect.Effect<ReadonlyArray<ServerAcpAgentStatus>, Error>;
  readonly getAgentServers: Effect.Effect<ReadonlyArray<AcpAgentServer>, Error>;
}

export class AcpAgentRegistry extends ServiceMap.Service<AcpAgentRegistry, AcpAgentRegistryShape>()(
  "t3/provider/Services/AcpAgentRegistry",
) {}
