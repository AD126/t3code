import { ServiceMap } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface AcpAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "acp";
}

export class AcpAdapter extends ServiceMap.Service<AcpAdapter, AcpAdapterShape>()(
  "t3/provider/Services/AcpAdapter",
) {}
