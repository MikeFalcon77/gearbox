// Main area for a gear authoring session: path, open description, Validate.

import { OpenerService, ReactWidget, open } from "@theia/core/lib/browser";
import { MessageService } from "@theia/core/lib/common/message-service";
import { URI } from "@theia/core/lib/common/uri";
import { inject, injectable, postConstruct } from "@theia/core/shared/inversify";
import React from "@theia/core/shared/react";

import { GearboxService } from "../../common/protocol";
import { GearSessionService } from "../shell/gear-session-service";

@injectable()
export class GearAuthorWidget extends ReactWidget {
  static readonly ID = "gearbox.gear";
  static readonly LABEL = "Gear";

  @inject(GearSessionService) protected readonly session!: GearSessionService;
  @inject(GearboxService) protected readonly service!: GearboxService;
  @inject(OpenerService) protected readonly opener!: OpenerService;
  @inject(MessageService) protected readonly messages!: MessageService;

  protected validating = false;
  protected lastValidate = "";

  @postConstruct()
  protected init(): void {
    this.id = GearAuthorWidget.ID;
    this.title.label = GearAuthorWidget.LABEL;
    this.title.closable = true;
    this.addClass("gearbox-gear");
    this.toDispose.push(this.session.onDidChange(() => this.update()));
    this.update();
  }

  protected render(): React.ReactNode {
    const openGear = this.session.current;
    if (openGear === undefined) {
      return (
        <div className="gbx-gear" data-gear-empty>
          <div className="gbx-empty">No gear open. Use New Gear or Open Gear from Home.</div>
        </div>
      );
    }
    const gdl = this.session.gdlPath() ?? "";
    return (
      <div className="gbx-gear" data-gear-root={openGear.root}>
        <div className="gbx-detail-title">
          {openGear.label} <span className="gbx-id">{openGear.root}</span>
        </div>
        <div className="gbx-kv">
          <span>path</span>
          <span>
            <code>{openGear.root}</code>
          </span>
        </div>
        <div className="gbx-kv">
          <span>description</span>
          <span className="gbx-links">
            <a
              href="#"
              data-open-gear-gdl
              onClick={(e) => {
                e.preventDefault();
                void this.openGdl(gdl);
              }}
            >
              {gdl}
            </a>
          </span>
        </div>
        <div className="gbx-create-actions">
          <button
            type="button"
            className="theia-button main"
            data-gear-validate
            disabled={this.validating}
            onClick={() => void this.validate()}
          >
            Validate
          </button>
        </div>
        {this.lastValidate !== "" && (
          <pre className="gbx-gear-validate" data-gear-validate-result>
            {this.lastValidate}
          </pre>
        )}
      </div>
    );
  }

  protected async openGdl(path: string): Promise<void> {
    if (path === "") return;
    try {
      await open(this.opener, URI.fromFilePath(path));
    } catch (error) {
      this.messages.error(error instanceof Error ? error.message : String(error));
    }
  }

  protected async validate(): Promise<void> {
    this.validating = true;
    this.update();
    try {
      const result = await this.service.validate();
      this.lastValidate = `${result.errors} error(s), ${result.warnings} warning(s)`;
      if ((result.diagnostics ?? []).length > 0) {
        this.lastValidate +=
          "\n" +
          result.diagnostics!
            .slice(0, 12)
            .map((d) => `${d.severity}: ${d.message}`)
            .join("\n");
      }
    } catch (error) {
      this.lastValidate = error instanceof Error ? error.message : String(error);
    } finally {
      this.validating = false;
      this.update();
    }
  }
}
