import { Emitter } from "@theia/core/lib/common/event";
import {
  inject,
  injectable,
  postConstruct,
} from "@theia/core/shared/inversify";
import { DemoDeployService, acceptDemoState, type DemoDeployState } from "../common/demo-deploy";
const KEY = "gearbox.familyLabs.deployment";
@injectable()
export class DemoDeployFrontend {
  @inject(DemoDeployService) private readonly service!: DemoDeployService;
  private readonly changed = new Emitter<void>();
  readonly onChanged = this.changed.event;
  state: DemoDeployState = {
    epoch: "",
    revision: 0,
    status: "idle",
    stage: "prepared",
    message: "Use the verified local bundle. Deploy does not build containers.",
    events: [],
    ui: { status: "disconnected" },
  };
  private busy = false;
  @postConstruct() protected init(): void {
    const id = sessionStorage.getItem(KEY);
    if (id) void this.refresh(id);
  }
  receive = (state: DemoDeployState) => {
    if (!acceptDemoState(this.state, state)) return;
    this.state = state;
    this.changed.fire();
  };
  async start(productPath: string, profile: string): Promise<void> {
    if (this.busy || this.state.status === "running") return;
    const id = crypto.randomUUID();
    this.busy = true;
    sessionStorage.setItem(KEY, id);
    this.receive({
      ...this.state,
      operationId: id,
      revision: 0,
      status: "running",
      stage: "validate",
      message: "Starting prepared deployment…",
      events: [],
    });
    try {
      this.receive(await this.service.start(productPath, profile, id));
    } catch (cause) {
      this.receive({
        ...this.state,
        status: "unknown",
        message:
          "The deployment acknowledgement was lost or refused. Check status; the operation will not be started again automatically.",
      });
    } finally {
      this.busy = false;
    }
  }
  async refresh(id = this.state.operationId): Promise<void> {
    try {
      this.receive(await this.service.getState(id));
    } catch {
      this.receive({
        ...this.state,
        status: "unknown",
        message:
          "Deployment status is unavailable. Check the connection and retry Check status.",
      });
    }
  }
  async reconnectUi(): Promise<void> {
    try {
      this.receive(await this.service.connectUi());
    } catch {
      this.receive({
        ...this.state,
        ui: { status: "lost" },
        message: "The UI connection could not be restored.",
      });
    }
  }
  openUi(): void {
    if (this.state.ui.status === "ready")
      window.open("http://localhost:8080/#settings", "_blank", "noopener");
  }
}
