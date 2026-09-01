// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;
let disposables: { dispose(): void }[] | undefined;

export function initLog(context: vscode.ExtensionContext): vscode.LogOutputChannel {
  disposables = context.subscriptions;
  return log();
}

export function log(): vscode.LogOutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("3270 Terminal", { log: true });
    disposables?.push(channel);
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
    `3270 Terminal: ${message}`,
    "Show Log"
  ).then((choice) => {
    if (choice === "Show Log") {
      log().show(true);
    }
  });
}
