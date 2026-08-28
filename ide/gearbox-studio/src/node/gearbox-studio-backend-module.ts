// One service per frontend connection, one engine per service.

import { ConnectionHandler, RpcConnectionHandler } from "@theia/core/lib/common/messaging";
import { ContainerModule } from "@theia/core/shared/inversify";

import { GEARBOX_SERVICE_PATH, GearboxClient, GearboxService } from "../common/protocol";
import { GearboxServiceImpl } from "./gearbox-service-impl";

export default new ContainerModule((bind) => {
  bind(GearboxServiceImpl).toSelf().inSingletonScope();
  bind(GearboxService).toService(GearboxServiceImpl);

  bind(ConnectionHandler)
    .toDynamicValue(
      ({ container }) =>
        new RpcConnectionHandler<GearboxClient>(GEARBOX_SERVICE_PATH, (client) => {
          // A child container per connection would give each frontend its own
          // engine; one engine for the workspace is what this slice needs, so
          // the service is a singleton and the client is swapped in.
          const service = container.get<GearboxServiceImpl>(GearboxServiceImpl);
          service.setClient(client);
          return service;
        }),
    )
    .inSingletonScope();
});
