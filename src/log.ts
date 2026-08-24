import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("TNZ 3270", { log: true });
    context.subscriptions.push(channel);
  }
  return channel;
}

export function log(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("TNZ 3270", { log: true });
  }
  return channel;
}

export function reportError(where: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  log().error(`${where}: ${message}`);
  if (err instanceof Error && err.stack) {
    log().debug(err.stack);
  }
  void vscode.window.showErrorMessage(
    `TNZ 3270: ${message}`,
    "Show Log"
  ).then((choice) => {
    if (choice === "Show Log") {
      log().show(true);
    }
  });
}
