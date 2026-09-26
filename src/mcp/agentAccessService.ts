import type { AgentAccessStatus } from "../shared/agentAccess";
import { AgentAccessServer, type AgentAccessServerOptions } from "./agentAccessServer";

/**
 * On/off switch for the MCP listener. Start/stop is serialized through
 * a promise tail so a fast on→off→on in Settings can never leave the
 * port bound by a server the UI thinks is stopped.
 */
export class AgentAccessService {
  private readonly server: AgentAccessServer;
  private enabled = false;
  private error: string | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: AgentAccessServerOptions & { saveEnabled: (enabled: boolean) => void | Promise<void> },
  ) {
    this.server = new AgentAccessServer(options);
  }

  status(): AgentAccessStatus {
    return {
      enabled: this.enabled,
      listening: this.server.listening,
      mcpUrl: this.server.mcpUrl,
      port: this.server.port,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  setEnabled(enabled: boolean, persist = true): Promise<AgentAccessStatus> {
    const operation = this.tail.then(async () => {
      this.error = undefined;
      if (enabled) {
        try {
          await this.server.start();
        } catch (cause) {
          const code = (cause as NodeJS.ErrnoException).code;
          this.error = code === "EADDRINUSE"
            ? `Port ${this.server.port} is already in use by another program. Quit it (or the other DiskHound) and toggle this again.`
            : cause instanceof Error ? cause.message : String(cause);
        }
      } else {
        await this.server.stop();
      }
      this.enabled = enabled;
      if (persist) await this.options.saveEnabled(enabled);
      this.options.onChanged();
      return this.status();
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async dispose(): Promise<void> {
    await this.tail;
    await this.server.stop();
  }
}
