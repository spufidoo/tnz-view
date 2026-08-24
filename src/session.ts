import * as vscode from "vscode";
import { log } from "./log";
import { Sidecar } from "./sidecar";
import { HostProfile, SidecarEvent } from "./types";

export class SessionPanel {
  static readonly viewType = "tnzView.session";

  readonly sessionId: string;
  private readonly panel: vscode.WebviewPanel;
  private insertMode = false;

  constructor(
    private readonly sidecar: Sidecar,
    readonly host: HostProfile,
    extensionUri: vscode.Uri,
    private readonly hooks: { onDispose: () => void; onFocus: () => void }
  ) {
    this.sessionId = host.id;
    this.panel = vscode.window.createWebviewPanel(
      SessionPanel.viewType,
      host.label,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
      }
    );
    this.panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.svg");
    this.panel.webview.html = this.html(this.panel.webview, extensionUri);

    this.panel.onDidDispose(() => {
      try {
        this.sidecar.send({ op: "disconnect", sessionId: this.sessionId });
      } catch {
        /* ignore */
      }
      this.hooks.onDispose();
    });

    this.panel.onDidChangeViewState((e) => {
      void vscode.commands.executeCommand(
        "setContext",
        "tnzView.sessionActive",
        e.webviewPanel.active
      );
      if (e.webviewPanel.active) {
        this.hooks.onFocus();
      }
    });

    this.panel.webview.onDidReceiveMessage((msg: { op: string; [k: string]: unknown }) => {
      if (msg.op === "key" || msg.op === "click" || msg.op === "paste") {
        this.sidecar.send({ ...msg, sessionId: this.sessionId });
      } else if (msg.op === "insert") {
        this.insertMode = Boolean(msg.value);
        this.setStatus();
      }
    });
  }

  reveal(): void {
    this.panel.reveal();
  }

  handleEvent(ev: SidecarEvent): void {
    if (ev.op === "ready") {
      return;
    }
    if (ev.sessionId && ev.sessionId !== this.sessionId) {
      return;
    }
    void this.panel.webview.postMessage(ev);
    if (ev.op === "status" || ev.op === "screen") {
      this.setStatus();
    }
    if (ev.op === "status" && ev.seslost) {
      this.panel.title = `${this.host.label} (lost)`;
    }
    if (ev.op === "error" && !ev.message.includes("Input Inhibit")) {
      log().error(`session ${this.host.label}: ${ev.message}`);
      void vscode.window
        .showWarningMessage(`TNZ 3270: ${firstLine(ev.message)}`, "Show Log")
        .then((choice) => {
          if (choice === "Show Log") {
            log().show(true);
          }
        });
    }
  }

  sendAid(aid: string): void {
    this.sidecar.send({
      op: "key",
      sessionId: this.sessionId,
      type: "aid",
      value: aid,
    });
  }

  connect(): void {
    this.panel.title = this.host.label;
    this.sidecar.send({
      op: "connect",
      sessionId: this.sessionId,
      host: this.host.host,
      port: this.host.port,
      secure: this.host.secure,
      verifyCert: this.host.verifyCert,
      luName: this.host.luName || "",
      tn3270e: this.host.tn3270e !== false,
      codePage: this.host.codePage,
      psSize: this.host.psSize,
      secLevel: this.host.secLevel,
    });
  }

  private setStatus(): void {
    const tls = this.host.secure ? "TLS" : "plain";
    const ins = this.insertMode ? "INS" : "REP";
    this.panel.title = `${this.host.label} · ${ins} · ${tls}`;
  }

  private html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "screen.css")
    );
    const js = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "screen.js")
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${css}" />
  <title>3270</title>
</head>
<body>
  <div id="wrap">
    <div id="screen" tabindex="0" aria-label="3270 screen"></div>
    <div id="status">
      <span id="oia-lock">X</span>
      <span id="oia-ins">REP</span>
      <span id="oia-pos">1,1</span>
      <span id="oia-size">24x80</span>
      <span id="oia-color">BASE COLOR</span>
      <span id="oia-msg">Connecting…</span>
    </div>
  </div>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function firstLine(message: string): string {
  const line = message.split("\n").find((l) => l.trim()) ?? message;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
