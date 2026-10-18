import { randomUUID } from "node:crypto";
import { injectable } from "@theia/core/shared/inversify";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  type DemoDeployClient,
  type DemoDeployService,
  type DemoDeployState,
  type DemoProgress,
} from "../common/demo-deploy";
import { findRepoRoot } from "./gearbox-service-impl";
const validId = (id: string) =>
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id);
const UI_URL = "http://localhost:8080/#settings";
@injectable()
export class DemoDeployServiceImpl implements DemoDeployService {
  private readonly repo = findRepoRoot(__dirname);
  private readonly clients = new Set<DemoDeployClient>();
  private operation: DemoDeployState = {
    epoch: randomUUID(),
    revision: 0,
    status: "idle",
    stage: "prepared",
    message: "Deploy the prepared Family Labs bundle.",
    events: [],
    ui: { status: "disconnected" },
  };
  private job: ChildProcess | undefined;
  private forward: ChildProcess | undefined;
  addClient(client: DemoDeployClient): () => void {
    this.clients.add(client);
    return () => this.clients.delete(client);
  }
  private update(change: Partial<DemoDeployState>) {
    this.operation = {
      ...this.operation,
      ...change,
      revision: this.operation.revision + 1,
    };
    for (const client of this.clients) {
      try {
        client.onChanged(this.operation);
      } catch {
        /* Connection closure does not cancel a deployment. */
      }
    }
  }
  async start(
    productPath: string,
    profile: string,
    operationId: string,
  ): Promise<DemoDeployState> {
    if (!validId(operationId))
      throw Error("Invalid deployment operation identifier");
    const expected = path.join(
      this.repo,
      "products/settings-community-demo/product.gdl",
    );
    if (
      profile !== "minikube" ||
      fs.realpathSync(productPath) !== fs.realpathSync(expected)
    )
      throw Error(
        "Deploy is limited to the prepared Family Labs product and minikube profile",
      );
    if (this.operation.operationId === operationId) return this.operation;
    const previous = path.join(
      this.repo,
      ".gearbox/settings-community-demo/operations",
      operationId + ".json",
    );
    if (fs.existsSync(previous)) return this.getState(operationId); // Never rerun a request after a lost acknowledgement.
    if (this.job || this.operation.status === "running")
      throw Error("A demo deployment is already running");
    this.update({
      operationId,
      status: "running",
      stage: "validate",
      message: "Validating the prepared bundle…",
      events: [],
    });
    // A Service forward binds one pod. Retire it before the next upgrade can
    // replace that pod; completion opens a fresh forward to the new workload.
    const previousForward = this.forward;
    this.forward = undefined;
    previousForward?.stdin?.end();
    this.update({ui: {status: "disconnected"}});
    const child = this.launch(
      ["deploy", "--operation", operationId],
      (event) => {
        this.update({
          stage: event.stage,
          message: event.message,
          events: [...this.operation.events, event].slice(-40),
        });
      },
    );
    this.job = child;
    child.once("error", () => {
      if (this.job === child) {
        this.job = undefined;
        this.update({
          status: "error",
          message: "The demo runner could not start.",
        });
      }
    });
    child.once("close", (code) => {
      if (this.job !== child) return;
      this.job = undefined;
      if (code === 0 && this.operation.stage === "ready") {
        this.update({
          status: "ready",
          stage: "ready",
          message: "Deployment is ready.",
        });
        void this.connectUi().catch(() => {});
      } else
        this.update({
          status: "error",
          message:
            this.operation.stage === "error"
              ? this.operation.message
              : "Deployment failed. See the private preparation logs.",
        });
    });
    return this.operation;
  }
  async getState(operationId?: string): Promise<DemoDeployState> {
    if (!operationId || operationId === this.operation.operationId)
      return this.operation;
    if (!validId(operationId)) throw Error("Invalid operation identifier");
    const file = path.join(
      this.repo,
      ".gearbox/settings-community-demo/operations",
      operationId + ".json",
    );
    if (!fs.existsSync(file))
      return {
        ...this.operation,
        operationId,
        status: "unknown",
        message:
          "No receipt for this request. Check deployment status before starting another operation.",
      };
    const receipt = JSON.parse(fs.readFileSync(file, "utf8")) as DemoProgress;
    const status =
      receipt.stage === "ready" && receipt.status === "ready"
        ? "ready"
        : receipt.status === "error"
          ? "error"
          : "unknown";
    const recovered: DemoDeployState = {
      epoch: this.operation.epoch,
      revision: this.operation.revision,
      operationId,
      status,
      stage: receipt.stage,
      message:
        status === "unknown"
          ? "The previous host session ended. Check the cluster before starting another operation."
          : receipt.message,
      events: [receipt],
      ui: this.operation.ui,
    };
    // Reading a historical receipt must not replace the job receiving progress.
    if (!this.operation.operationId && !this.job) {
      this.update(recovered);
      return this.operation;
    }
    return recovered;
  }
  async connectUi(): Promise<DemoDeployState> {
    if (this.forward) return this.operation;
    this.update({
      ui: { status: "connecting" },
      ...(this.operation.status === "ready"
        ? { message: "Connecting UI…" }
        : {}),
    });
    const child = this.launch(["forward"], (event) => {
      if (event.stage === "open-ui" && event.status === "ready")
        this.update({
          ui: { status: "ready", url: UI_URL },
          ...(this.operation.status === "ready"
            ? { message: "Deployment is ready." }
            : {}),
        });
    });
    this.forward = child;
    const lost = () => {
      if (this.forward === child) {
        this.forward = undefined;
        this.update({
          ui: { status: "lost" },
          ...(this.operation.status === "ready"
            ? {message: "UI connection lost. Reconnect UI to restore it."} : {}),
        });
      }
    };
    child.once("error", lost);
    child.once("close", lost);
    return this.operation;
  }
  onStop(): void {
    this.forward?.stdin?.end();
  }
  private launch(
    args: readonly string[],
    progress: (event: DemoProgress) => void,
  ): ChildProcess {
    const child = spawn(
      process.execPath,
      [
        path.join(
          this.repo,
          "products/settings-community-demo/scripts/demo.cjs",
        ),
        ...args,
      ],
      { cwd: this.repo, windowsHide: true, detached: args[0] === "deploy", stdio: ["pipe", "pipe", "pipe"] },
    );
    let pending = "";
    child.stdout?.on("data", (bytes: Buffer) => {
      pending += bytes.toString();
      if (pending.length > 65536) {
        pending = "";
        return;
      }
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.startsWith("@@demo ")) continue;
        try {
          const event = JSON.parse(line.slice(7));
          if (
            typeof event.stage === "string" &&
            typeof event.status === "string" &&
            typeof event.message === "string"
          )
            progress({
              stage: event.stage,
              status: event.status,
              message: event.message,
            });
        } catch {
          /* Non-protocol output stays private. */
        }
      }
    });
    child.stderr?.on("data", () => {});
    return child;
  }
}
