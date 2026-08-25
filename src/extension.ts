import { randomUUID } from "crypto";
import * as vscode from "vscode";
import {
  deleteHost,
  getHosts,
  newHost,
  upsertHost,
} from "./hosts";
import { HostEditorPanel } from "./hostEditor";
import { refreshKeymapView, showKeymap } from "./keymapView";
import { initLog, log, reportError } from "./log";
import { getMacros } from "./macros";
import { download, upload } from "./transfer";
import { Sidecar } from "./sidecar";
import { SessionPanel } from "./session";
import { HostItem, HostTreeProvider } from "./tree";
import { HostProfile, SidecarEvent } from "./types";

export function activate(context: vscode.ExtensionContext): void {
  initLog(context);
  const tree = new HostTreeProvider();
  const sidecar = new Sidecar(
    context.extensionPath,
    context.logUri.fsPath,
    context.globalStorageUri.fsPath
  );
  const sessions = new Map<string, SessionPanel>();
  let focusedId: string | undefined;

  /**
   * Track which session tab is on top.
   *
   * Derived from every panel rather than from one panel's event, because
   * switching between two sessions fires deactivate and activate in an order
   * that is not guaranteed.
   */
  const syncSession = (): void => {
    const active = [...sessions.values()].find((p) => p.isActive);
    if (active) {
      focusedId = active.sessionId;
    }
    void vscode.commands.executeCommand(
      "setContext",
      "tnzView.sessionActive",
      Boolean(active)
    );
  };

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("tnzView.hosts", tree),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("tnzView.hosts")) {
        tree.refresh();
      }
      if (e.affectsConfiguration("tnzView.keymap")) {
        for (const panel of sessions.values()) {
          panel.sendConfig();
        }
        refreshKeymapView(context.extensionUri);
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
    log().info(msg);
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

  // Saving from the editor tab also repaints any live session for that host,
  // so palette edits show up without reconnecting.
  const saveHost = async (host: HostProfile): Promise<void> => {
    await upsertHost(host);
    tree.refresh();
    sessions.get(host.id)?.applyProfile(host);
  };

  const openEditor = (host: HostProfile, isNew: boolean): void => {
    HostEditorPanel.show(context.extensionUri, host, isNew, saveHost);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("tnzView.hosts.add", () => {
      openEditor(newHost(), true);
    }),
    vscode.commands.registerCommand(
      "tnzView.hosts.edit",
      async (item?: HostItem) => {
        const current = hostFromArg(item) ?? (await pickHost());
        if (!current) {
          return;
        }
        openEditor(current, false);
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
        openEditor(
          {
            ...current,
            id: randomUUID(),
            label: `${current.label} copy`,
          },
          true
        );
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
          reportError("start sidecar", err);
          tree.setStatus(host.id, "disconnected");
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
            syncSession();
          },
          onViewState: syncSession,
        });
        sessions.set(host.id, panel);
        focusedId = host.id;
        panel.connect();
        // A new panel is active straight away, but onDidChangeViewState only
        // fires on a change, so the context key has to be set here too.
        syncSession();
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
          reportError("disconnect", err);
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
    }),
    vscode.commands.registerCommand("tnzView.showKeymap", () => {
      showKeymap(context.extensionUri);
    }),
    vscode.commands.registerCommand("tnzView.session.runMacro", async () => {
      const panel = focusedId ? sessions.get(focusedId) : undefined;
      if (!panel) {
        void vscode.window.showWarningMessage("TNZ 3270: no active session.");
        return;
      }
      const names = Object.keys(getMacros());
      if (!names.length) {
        const choice = await vscode.window.showInformationMessage(
          "TNZ 3270: no macros defined.",
          "Edit Settings"
        );
        if (choice === "Edit Settings") {
          await vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "tnzView.macros"
          );
        }
        return;
      }
      const name = await vscode.window.showQuickPick(names.sort(), {
        title: "Run macro",
      });
      if (name) {
        panel.runMacro(name);
      }
    }),
    vscode.commands.registerCommand("tnzView.session.download", async () => {
      const panel = focusedId ? sessions.get(focusedId) : undefined;
      if (!panel) {
        void vscode.window.showWarningMessage("TNZ 3270: no active session.");
        return;
      }
      await download(panel);
    }),
    vscode.commands.registerCommand("tnzView.session.upload", async () => {
      const panel = focusedId ? sessions.get(focusedId) : undefined;
      if (!panel) {
        void vscode.window.showWarningMessage("TNZ 3270: no active session.");
        return;
      }
      await upload(panel);
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
