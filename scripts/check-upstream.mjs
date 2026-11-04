#!/usr/bin/env node
/*
 * Compares the ODRViewer runtime bundled in the extension (odrviewer/viewer.js and
 * odrviewer/viewer.wasm.base64) with the one published on odrviewer.io.
 *
 * Never fails because of upstream state: an unreachable site or a different
 * runtime is reported through outputs, not through the exit code.
 *
 * Outputs (appended to $GITHUB_OUTPUT when set, printed otherwise):
 *   status      same | different | unreachable
 *   compatible  true | false (only meaningful when status=different)
 *   short_sha   first 7 chars of sha256(upstream viewer.js + viewer.wasm)
 *   report      path of the markdown report (when status=different)
 *   upstream    directory with the downloaded files, ready to be bundled
 *
 * Environment:
 *   UPSTREAM_BASE_URL  default https://odrviewer.io
 *   OUTPUT_DIR         default ./upstream-check
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const BASE_URL = (process.env.UPSTREAM_BASE_URL || "https://odrviewer.io").replace(/\/+$/, "");
const OUTPUT_DIR = resolve(process.env.OUTPUT_DIR || "upstream-check");
const LOCAL_DIR = resolve(import.meta.dirname, "..", "odrviewer");
const TIMEOUT_MS = 60_000;

/**
 * Symbols the extension relies on (see odrviewer/index.js). Each is looked up in
 * viewer.js and in the wasm binary, because embind names and EM_ASM snippets can
 * live in either.
 */
const REQUIRED_SYMBOLS = [
  { name: "OdrViewer", why: "module factory called by index.js" },
  { name: "wasmBinary", why: "index.js injects the wasm bytes through Module.wasmBinary" },
  { name: "FS", why: "index.js writes the map with Module.FS.writeFile/unlink" },
  { name: "Viewer", why: "embind class used as Module.Viewer" },
  { name: "get_instance", why: "Module.Viewer.get_instance()" },
  { name: "load_map", why: "viewer.load_map(path, 0.1, firstLoad, true)" },
  { name: "render", why: "viewer.render()" },
  { name: "odr_log_callback", why: "global callback defined in index.js" },
  { name: "odr_popup_callback", why: "global callback defined in index.js" },
  { name: "jump_to_xodr_editor", why: "global callback defined in index.js" },
  { name: "open_xodr_editor", why: "global callback defined in index.js" },
  { name: "open_xodr_log", why: "global callback defined in index.js" },
  { name: "offer_fs_file_as_download", why: "global callback defined in index.js" },
];

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  }
  console.log(`${name}=${value}`);
}

async function download(file) {
  const url = `${BASE_URL}/${file}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`GET ${url} -> HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function wasmInterface(bytes) {
  const module = new WebAssembly.Module(bytes);
  return {
    imports: WebAssembly.Module.imports(module).map(i => `${i.module}.${i.name} (${i.kind})`),
    exports: WebAssembly.Module.exports(module).map(e => `${e.name} (${e.kind})`),
  };
}

function diff(before, after) {
  const a = new Set(before);
  const b = new Set(after);
  return {
    added: [...b].filter(x => !a.has(x)).sort(),
    removed: [...a].filter(x => !b.has(x)).sort(),
  };
}

function symbolPresent(name, js, wasm) {
  return js.includes(name) || wasm.includes(Buffer.from(name, "latin1"));
}

function list(items) {
  return items.length ? items.map(i => `- \`${i}\``).join("\n") : "_none_";
}

async function main() {
  const localJs = readFileSync(join(LOCAL_DIR, "viewer.js"));
  const localWasm = Buffer.from(readFileSync(join(LOCAL_DIR, "viewer.wasm.base64"), "utf8").trim(), "base64");

  let upstreamJs;
  let upstreamWasm;
  try {
    [upstreamJs, upstreamWasm] = await Promise.all([download("viewer.js"), download("viewer.wasm")]);
  } catch (error) {
    console.log(`::warning title=ODRViewer upstream check::Cannot download the runtime from ${BASE_URL}: ${error.message}`);
    setOutput("status", "unreachable");
    return;
  }

  const hashes = {
    localJs: sha256(localJs),
    localWasm: sha256(localWasm),
    upstreamJs: sha256(upstreamJs),
    upstreamWasm: sha256(upstreamWasm),
  };
  const shortSha = sha256(Buffer.concat([upstreamJs, upstreamWasm])).slice(0, 7);
  setOutput("short_sha", shortSha);

  if (hashes.localJs === hashes.upstreamJs && hashes.localWasm === hashes.upstreamWasm) {
    console.log("Bundled ODRViewer runtime matches odrviewer.io.");
    setOutput("status", "same");
    return;
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const upstreamDir = join(OUTPUT_DIR, "odrviewer");
  mkdirSync(upstreamDir, { recursive: true });
  writeFileSync(join(upstreamDir, "viewer.js"), upstreamJs);
  writeFileSync(join(upstreamDir, "viewer.wasm.base64"), upstreamWasm.toString("base64"));

  const problems = [];

  let wasmSection;
  try {
    const before = wasmInterface(localWasm);
    const after = wasmInterface(upstreamWasm);
    const imports = diff(before.imports, after.imports);
    const exports = diff(before.exports, after.exports);
    if (imports.added.length || imports.removed.length) {
      problems.push("wasm imports changed: viewer.js and viewer.wasm must be updated together");
    }
    if (exports.removed.length) {
      problems.push("wasm exports were removed");
    }
    wasmSection = [
      `#### Imports added\n${list(imports.added)}`,
      `#### Imports removed\n${list(imports.removed)}`,
      `#### Exports added\n${list(exports.added)}`,
      `#### Exports removed\n${list(exports.removed)}`,
    ].join("\n\n");
  } catch (error) {
    problems.push(`upstream viewer.wasm is not a valid WebAssembly module (${error.message})`);
    wasmSection = `Cannot compile the upstream wasm: \`${error.message}\``;
  }

  const symbolRows = REQUIRED_SYMBOLS.map(({ name, why }) => {
    const before = symbolPresent(name, localJs.toString("latin1"), localWasm);
    const after = symbolPresent(name, upstreamJs.toString("latin1"), upstreamWasm);
    if (before && !after) {
      problems.push(`symbol \`${name}\` is missing upstream (${why})`);
    }
    const mark = after ? "✅" : before ? "❌ missing" : "⚪ not found in bundled either";
    return `| \`${name}\` | ${mark} | ${why} |`;
  });

  const compatible = problems.length === 0;
  setOutput("compatible", String(compatible));

  const report = `A different ODRViewer runtime is published on ${BASE_URL}.

**Static compatibility check: ${compatible ? "✅ no breaking change detected" : "❌ needs manual review"}**
${compatible ? "" : `\n${problems.map(p => `- ${p}`).join("\n")}\n`}
> The check compares wasm import/export lists and looks for the symbols used by \`odrviewer/index.js\`.
> It does not run the viewer: load a few \`.xodr\` files in the Extension Development Host before releasing.

### SHA-256

| File | Bundled | Upstream |
|---|---|---|
| \`viewer.js\` | \`${hashes.localJs}\` | \`${hashes.upstreamJs}\` |
| \`viewer.wasm\` | \`${hashes.localWasm}\` | \`${hashes.upstreamWasm}\` |

### Symbols used by the extension

| Symbol | Upstream | Used for |
|---|---|---|
${symbolRows.join("\n")}

### WebAssembly interface

${wasmSection}

### How to update

\`\`\`sh
curl -fsSL -o odrviewer/viewer.js ${BASE_URL}/viewer.js
curl -fsSL ${BASE_URL}/viewer.wasm | base64 | tr -d '\\n' > odrviewer/viewer.wasm.base64
\`\`\`

The files ready to commit are also attached to the workflow run as the \`odrviewer-upstream\` artifact.
`;

  const reportPath = join(OUTPUT_DIR, "report.md");
  writeFileSync(reportPath, report);
  console.log(report);
  setOutput("status", "different");
  setOutput("report", reportPath);
  setOutput("upstream", upstreamDir);
}

await main();
