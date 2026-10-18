// Local Studio host capability; these types do not cross the Rust engine wire.
export const DEMO_DEPLOY_PATH = "/services/gearbox-demo-deploy";
export const DemoDeployService = Symbol("DemoDeployService");
export interface DemoProgress {
  stage: string;
  status: string;
  message: string;
}
export interface DemoDeployState {
  revision: number;
  operationId?: string;
  status: "idle" | "running" | "ready" | "error" | "unknown";
  stage: string;
  message: string;
  events: readonly DemoProgress[];
  ui: {
    status: "disconnected" | "connecting" | "ready" | "lost";
    url?: string;
  };
}
export interface DemoDeployService {
  start(
    productPath: string,
    profile: string,
    operationId: string,
  ): Promise<DemoDeployState>;
  getState(operationId?: string): Promise<DemoDeployState>;
  connectUi(): Promise<DemoDeployState>;
}
export interface DemoDeployClient {
  onChanged(state: DemoDeployState): void;
}
