import type { AcpRegistryListResult } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface AcpRegistryClientShape {
  readonly listAgents: Effect.Effect<AcpRegistryListResult, Error>;
}

export class AcpRegistryClient extends ServiceMap.Service<
  AcpRegistryClient,
  AcpRegistryClientShape
>()("t3/provider/Services/AcpRegistryClient") {}
