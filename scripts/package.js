// Copyright (c) 2026 Marcus Davage
// SPDX-License-Identifier: Apache-2.0

/**
 * Package the extension under a chosen name.
 *
 * The source carries no product branding: the manifest is overlaid from
 * branding/<flavour>.json just long enough to build, then put back exactly
 * as it was. That keeps one codebase behind every build.
 *
 *   node scripts/package.js        neutral build
 *   node scripts/package.js bmc    BMC AMI DevX build
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");
const manifest = path.join(root, "package.json");
const flavour = process.argv[2] || "default";
const overlay = path.join(root, "branding", `${flavour}.json`);

if (!fs.existsSync(overlay)) {
  console.error(`No branding/${flavour}.json. Available:`);
  for (const f of fs.readdirSync(path.join(root, "branding"))) {
    console.error(`  ${path.basename(f, ".json")}`);
  }
  process.exit(1);
}

const original = fs.readFileSync(manifest, "utf8");
const pkg = JSON.parse(original);
Object.assign(pkg, JSON.parse(fs.readFileSync(overlay, "utf8")));

const suffix = flavour === "default" ? "" : `-${flavour}`;
const out = `${pkg.name}${suffix}-${pkg.version}.vsix`;

// vsce only recognises github.com and gitlab.com, so it cannot work out where
// the relative links in the README point. Tell it.
const repo = (pkg.repository?.url ?? "").replace(/\.git$/, "");
const links = repo
  ? [
      "--baseContentUrl",
      `${repo}/blob/main`,
      "--baseImagesUrl",
      `${repo}/raw/main`,
    ]
  : [];

fs.writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}\n`);
try {
  console.log(`Packaging "${pkg.displayName}" as ${out}`);
  const run = spawnSync("npx", ["vsce", "package", "--out", out, ...links], {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
  process.exitCode = run.status === null ? 1 : run.status;
} finally {
  // Restore byte for byte, whether or not the build worked.
  fs.writeFileSync(manifest, original);
}
