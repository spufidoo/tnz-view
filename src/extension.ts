import { randomUUID } from "crypto";
import * as vscode from "vscode";
import {
  deleteHost,
  getHosts,
  promptHost,
  upsertHost,
} from "./hosts";
import { Sidecar } from "./sidecar";
import { SessionPanel } from "./session";
import { HostItem, HostTreeProvider } from "./tree";
import { HostProfile, SidecarEvent } from "./types";

export function activate(context: vscode.ExtensionContext): void {
  const tree = new HostTreeProvider();
  const sidecar = new Sidecar(context.extensionPath);
  const sessions = new Map<string, SessionPanel>();
  let focusedId: string | undefined;

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("tnzView.hosts", tree),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tnzView.hosts")) {
        tree.refresh();
      }
    }),
    { dispose: () => sidecar.dispose() }
  );

  sidecar.on("event", (ev: SidecarEvent) => {
    if (ev.op === "ready") {
      return;
    }
    const panel = ev.sessionId ? sessions.get(ev.sessionId) : undefined;
    panel?.handleEvent(ev);
    if (ev.op === "status" && ev.sessionId) {
      if (ev.seslost) {
        tree.setStatus(ev.sessionId, "lost");
      } else if (ev.connected) {
        tree.setStatus(ev.sessionId, "connected");
      } else {
        tree.setStatus(ev.sessionId, "disconnected");
      }
    }
  });
  sidecar.on("log", (msg: string) => {
    console.log("[tnz-view]", msg);
  });
  sidecar.on("exit", () => {
    for (const id of sessions.keys()) {
      tree.setStatus(id, "lost");
    }
  });

  const hostFromArg = (item?: HostItem | HostProfile): HostProfile | undefined => {
    if (!item) {
      return undefined;
    }
    if (item instanceof HostItem) {
      return item.profile;
    }
    if ("id" in item && "host" in item) {
      return item;
    }
    return undefined;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("tnzView.hosts.add", async () => {
      const host = await promptHost();
      if (!host) {
        return;
      }
      await upsertHost(host);
      tree.refresh();
    }),
    vscode.commands.registerCommand(
      "tnzView.hosts.edit",
      async (item?: HostItem) => {
        const current = hostFromArg(item) ?? (await pickHost());
        if (!current) {
          return;
        }
        const updated = await promptHost(current);
        if (!updated) {
          return;
        }
        await upsertHost(updated);
        tree.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "tnzView.hosts.delete",
      async (item?: HostItem) => {
        const current = hostFromArg(item) ?? (await pickHost());
        if (!current) {
          return;
        }
        const ok = await vscode.window.showWarningMessage(
          `Delete host ${current.label}?`,
          { modal: true },
          "Delete"
        );
        if (ok !== "Delete") {
          return;
        }
        await deleteHost(current.id);
        tree.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "tnzView.hosts.duplicate",
      async (item?: HostItem) => {
        const current = hostFromArg(item) ?? (await pickHost());
        if (!current) {
          return;
        }
        const updated = await promptHost({
          ...current,
          id: randomUUID(),
          label: `${current.label} copy`,
        });
        if (!updated) {
          return;
        }
        await upsertHost({ ...updated, id: randomUUID() });
        tree.refresh();
      }
    ),
    vscode.commands.registerCommand(
      "tnzView.hosts.connect",
      async (item?: HostItem | HostProfile) => {
        const host = hostFromArg(item) ?? (await pickHost());
        if (!host) {
          return;
        }
        const existing = sessions.get(host.id);
        if (existing) {
          existing.reveal();
          const status = tree.getStatus(host.id);
          if (status !== "connected" && status !== "connecting") {
            tree.setStatus(host.id, "connecting");
            existing.connect();
          }
          return;
        }
        try {
          await sidecar.ensureStarted();
        } catch (err) {
          void vscode.window.showErrorMessage(String(err));
          return;
        }
        tree.setStatus(host.id, "connecting");
        const panel = new SessionPanel(sidecar, host, context.extensionUri, {
          onDispose: () => {
            sessions.delete(host.id);
            if (focusedId === host.id) {
              focusedId = undefined;
            }
            tree.setStatus(host.id, "disconnected");
            void vscode.commands.executeCommand(
              "setContext",
              "tnzView.sessionActive",
              false
            );
          },
          onFocus: () => {
            focusedId = host.id;
          },
        });
        sessions.set(host.id, panel);
        focusedId = host.id;
        panel.connect();
      }
    ),
    vscode.commands.registerCommand(
      "tnzView.hosts.disconnect",
      async (item?: HostItem) => {
        const host = hostFromArg(item) ?? (await pickHost());
        if (!host) {
          return;
        }
        try {
          sidecar.send({ op: "disconnect", sessionId: host.id });
        } catch (err) {
          void vscode.window.showErrorMessage(String(err));
        }
        tree.setStatus(host.id, "disconnected");
      }
    ),
    vscode.commands.registerCommand("tnzView.session.clear", () => {
      const panel = focusedId ? sessions.get(focusedId) : undefined;
      panel?.sendAid("clear");
    }),
    vscode.commands.registerCommand("tnzView.session.attn", () => {
      const panel = focusedId ? sessions.get(focusedId) : undefined;
      panel?.sendAid("attn");
    })
  );
}

export function deactivate(): void {
  /* sidecar disposed via subscriptions */
}

async function pickHost(): Promise<HostProfile | undefined> {
  const hosts = getHosts();
  if (!hosts.length) {
    void vscode.window.showInformationMessage("Add a host first.");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    hosts.map((h) => ({
      label: h.label,
      description: `${h.host}:${h.port}`,
      host: h,
    })),
    { placeHolder: "Select a host" }
  );
  return picked?.host;
}
