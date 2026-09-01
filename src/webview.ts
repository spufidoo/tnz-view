// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

const NONCE_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A per-document nonce, so the CSP can allow our script and nothing else. */
export function getNonce(): string {
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += NONCE_CHARS.charAt(Math.floor(Math.random() * NONCE_CHARS.length));
  }
  return nonce;
}
