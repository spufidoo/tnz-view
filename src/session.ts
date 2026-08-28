import * as fs from "fs";
import * as vscode from "vscode";
import { resolveKeymap } from "./keymap";
import { log } from "./log";
import { Sidecar } from "./sidecar";
import { fillPrompts, hasPrompt, resolveNamedMacro } from "./macros";
import { buildParms, getSyntax } from "./transfer";
import {
  DEFAULT_COLORS,
  HostProfile,
  ScriptAskEvent,
  SidecarEvent,
  TransferEvent,
  TransferRequest,
} from "./types";

export class SessionPanel {
  static readonly viewType = "tnzView.session";

  readonly sessionId: string;
  private readonly panel: vscode.WebviewPanel;
  private insertMode = false;
  private transferSeq = 0;
  private windowTitle: string | undefined;
  private readonly pending = new Map<string, (ev: TransferEvent) => void>();

  constructor(
    private readonly sidecar: Sidecar,
    public host: HostProfile,
    extensionUri: vscode.Uri,
    private readonly macrosDir: string,
    private readonly hooks: { onDispose: () => void; onViewState: () => void }
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
      for (const [transferId, resolve] of this.pending) {
        resolve({
          op: "transfer",
          sessionId: this.sessionId,
          transferId,
          state: "done",
          ok: false,
          message: "the session was closed",
        });
      }
      this.pending.clear();
      this.hooks.onDispose();
    });

    this.panel.onDidChangeViewState(() => this.hooks.onViewState());

    this.panel.webview.onDidReceiveMessage((msg: { op: string; [k: string]: unknown }) => {
      if (msg.op === "key" || msg.op === "paste") {
        this.sidecar.send({ ...msg, sessionId: this.sessionId });
      } else if (msg.op === "click") {
        this.sidecar.send({ ...msg, sessionId: this.sessionId });
        if (msg.ctrl) {
          const name = vscode.workspace
            .getConfiguration("tnzView")
            .get<string>("clickMacro", "")
            .trim();
          if (name) {
            void this.runMacro(name);
          }
        }
      } else if (msg.op === "macro") {
        void this.runMacro(String(msg.name ?? ""));
      } else if (msg.op === "insert") {
        this.insertMode = Boolean(msg.value);
        this.setStatus();
      }
    });
  }

  reveal(): void {
    this.panel.reveal();
  }

  get isActive(): boolean {
    return this.panel.active;
  }

  /** Put the keyboard back in the 3270 after a command took focus away. */
  focus(): void {
    this.panel.reveal(undefined, false);
    void this.panel.webview.postMessage({ op: "focus" });
  }

  /** Apply an edited profile. Colours repaint live; the rest needs a reconnect. */
  applyProfile(host: HostProfile): void {
    this.host = host;
    this.sendConfig();
    this.setStatus();
  }

  sendConfig(): void {
    void this.panel.webview.postMessage({
      op: "config",
      colors: this.host.colors ?? DEFAULT_COLORS,
      blink: this.host.blink === true,
      keymap: resolveKeymap(),
      fontFamily: this.host.fontFamily ?? "",
    });
  }

  /**
   * Run an IND$FILE transfer.
   *
   * The sidecar answers with a single done event, so the promise settles even
   * when the host never replies; its idle timeout is the backstop.
   */
  transfer(req: TransferRequest): Promise<TransferEvent> {
    const transferId = `t${++this.transferSeq}`;
    return new Promise((resolve) => {
      this.pending.set(transferId, resolve);
      this.sidecar.send({
        op: "transfer",
        sessionId: this.sessionId,
        transferId,
        direction: req.direction,
        localPath: req.localPath,
        parms: buildParms(req, getSyntax()),
        idleTimeout: vscode.workspace
          .getConfiguration("tnzView")
          .get<number>("transfer.idleTimeout", 60),
      });
    });
  }

  handleEvent(ev: SidecarEvent): void {
    if (ev.op === "ready") {
      return;
    }
    if (ev.sessionId && ev.sessionId !== this.sessionId) {
      return;
    }
    if (ev.op === "scriptAsk") {
      void this.answerScriptAsk(ev);
      return;
    }
    if (ev.op === "scriptTitle") {
      this.windowTitle = ev.title.trim() || undefined;
      this.setStatus();
      return;
    }
    void this.panel.webview.postMessage(ev);
    if (ev.op === "transfer") {
      if (ev.state === "done") {
        this.pending.get(ev.transferId)?.(ev);
        this.pending.delete(ev.transferId);
      }
      return;
    }
    if (ev.op === "status" || ev.op === "screen") {
      this.setStatus();
    }
    if (ev.op === "status" && ev.seslost) {
      this.panel.title = `${this.windowTitle || this.host.label} (lost)`;
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

  /** Expand a named tape or script and hand it to the sidecar. */
  async runMacro(name: string): Promise<void> {
    const resolved = resolveNamedMacro(name, this.macrosDir);
    if (!resolved) {
      return;
    }
    if (resolved.kind === "script") {
      if (!fs.existsSync(resolved.path)) {
        void vscode.window.showErrorMessage(
          `TNZ 3270: macro "${name}": no file at ${resolved.path}. Use Open Macros Folder to create it.`
        );
        return;
      }
      this.sidecar.send({
        op: "script",
        sessionId: this.sessionId,
        name,
        path: resolved.path,
      });
      this.focus();
      return;
    }
    const asked = hasPrompt(resolved.steps);
    const steps = asked ? await fillPrompts(name, resolved.steps) : resolved.steps;
    if (!steps) {
      return;
    }
    this.sidecar.send({
      op: "macro",
      sessionId: this.sessionId,
      name,
      steps,
    });
    if (asked) {
      this.focus();
    }
  }

  private async answerScriptAsk(ev: ScriptAskEvent): Promise<void> {
    const reply = (cancelled: boolean, value?: string) => {
      try {
        this.sidecar.send({
          op: "scriptReply",
          sessionId: this.sessionId,
          askId: ev.askId,
          cancelled,
          value: value ?? "",
        });
      } catch {
        /* sidecar gone */
      }
      this.focus();
    };
    if (ev.kind === "warn") {
      await vscode.window.showWarningMessage(ev.prompt, { modal: true });
      reply(false);
      return;
    }
    const value = await vscode.window.showInputBox({
      title: `Macro`,
      prompt: ev.prompt,
      value: ev.kind === "password" ? undefined : ev.value,
      password: ev.kind === "password",
      ignoreFocusOut: true,
      validateInput:
        ev.maxLength && ev.maxLength > 0
          ? (s) =>
              s.length > ev.maxLength!
                ? `At most ${ev.maxLength} characters`
                : undefined
          : undefined,
    });
    if (value === undefined) {
      reply(true);
      return;
    }
    reply(false, value);
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
    this.windowTitle = undefined;
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
      capableColor: this.host.extendedColor !== false,
    });
  }

  private setStatus(): void {
    const name = this.windowTitle || this.host.label;
    const tls = this.host.secure ? "TLS" : "plain";
    const ins = this.insertMode ? "INS" : "REP";
    this.panel.title = `${name} · ${ins} · ${tls}`;
  }

  private html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const css = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "screen.css")
    );
    const js = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "screen.js")
    );
    const nonce = getNonce();
    const config = JSON.stringify({
      colors: this.host.colors ?? DEFAULT_COLORS,
      blink: this.host.blink === true,
      keymap: resolveKeymap(),
      fontFamily: this.host.fontFamily ?? "",
    }).replace(/</g, "\\u003c");
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
  <script nonce="${nonce}">window.__TNZ_CONFIG__ = ${config};</script>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}

function firstLine(message: string): string {
    const line = message.split("\n").find((l) => l.trim()) ?? message;
    return line.length > 320 ? `${line.slice(0, 320)}…` : line;
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
