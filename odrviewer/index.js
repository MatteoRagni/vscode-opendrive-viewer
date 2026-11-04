/*
* Copyright 2024 Matteo Ragni
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const fs = require("fs");
const crypto = require("crypto");
const vscode = require("vscode");

function getWebViewIndexHtml(context) {
  const nonce = crypto.randomBytes(16).toString("base64");
  const viewerWasmPath = vscode.Uri.joinPath(context.extensionUri, "odrviewer", "viewer.wasm.base64").fsPath;
  const viewerJsPath = vscode.Uri.joinPath(context.extensionUri, "odrviewer", "viewer.js").fsPath;
  const viewerWasm = fs.readFileSync(viewerWasmPath, "utf8");
  const viewerJs = fs.readFileSync(viewerJsPath);
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'unsafe-inline';">
  <style>
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      padding: 0;
      overflow: hidden;
    }
    #canvas {
      position: absolute;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
    }        
  </style>
</head>
<body>
  <canvas id="canvas"></canvas>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    window.addEventListener("error", event => {
      const error = event.error || event.message;
      vscode.postMessage({ command: "error", message: String(error) });
    });
    window.addEventListener("unhandledrejection", event => {
      vscode.postMessage({ command: "error", message: String(event.reason) });
    });
  
    // Loaded by the extension
    const ViewerWasm = \`${viewerWasm}\`;
    const wasmBytes = Uint8Array.from(atob(ViewerWasm), character => character.charCodeAt(0));
    ${viewerJs}
    // End of extension loaded data

    function odr_log_callback(level, message) {
      const logMessage = "[" + level + "] " + message;
      vscode.postMessage({ command: "log", level, message: String(message) });
      if (level === "ERROR") {
        console.error(logMessage);
      } else {
        console.log(logMessage);
      }
    }

    function odr_popup_callback(type, message) {
      if (type === "error") {
        vscode.postMessage({ command: "error", message: String(message) });
      }
    }

    function jump_to_xodr_editor(byteOffset) {
      vscode.postMessage({ command: "jumpToEditor", byteOffset });
    }

    function open_xodr_editor() {
      vscode.postMessage({ command: "openEditor" });
    }

    function open_xodr_log() {
      vscode.postMessage({ command: "openLog" });
    }

    function offer_fs_file_as_download(filename) {
      vscode.postMessage({
        command: "error",
        message: "This functionality is not yet implemented",
      });
    }

    const canvas = document.getElementById("canvas");
    canvas.addEventListener("contextmenu", event => {
      event.preventDefault();
    });
    
    let OpenDriveViewer = null;
    let ModuleOdrViewer = null;
    let firstLoad = true;
    let pendingPayload = [];
    let payloadQueue = Promise.resolve();
    let renderLoopStarted = false;
    
  
    function render() {
      if (!OpenDriveViewer) {
        renderLoopStarted = false;
        return;
      }

      try {
        OpenDriveViewer.render();
      } catch (error) {
        renderLoopStarted = false;
        vscode.postMessage({
          command: "error",
          message: error instanceof Error ? error.message : String(error)
        });
        return;
      }

      requestAnimationFrame(render);
    };
  
    async function onPayload(payload, notificationId, fileName) {
      try {
        if (!OpenDriveViewer) OpenDriveViewer = ModuleOdrViewer.Viewer.get_instance();
        const mapPath = "./" + (typeof fileName === "string" && fileName ? fileName : "data.xodr");

        document.body.offsetWidth;
        await new Promise(requestAnimationFrame);

        if (typeof payload !== "string" || !payload.trim()) {
          throw new Error("Received empty OpenDRIVE document (length: " + (payload?.length ?? 0) + ")");
        }

        const parsed = new DOMParser().parseFromString(payload, "application/xml");
        if (!parsed.documentElement || parsed.documentElement.nodeName !== "OpenDRIVE" || parsed.getElementsByTagName("parsererror").length > 0) {
          throw new Error("Received XML without an OpenDRIVE document element (length: " + payload.length + ")");
        }

        try {
          ModuleOdrViewer.FS.unlink(mapPath);
        } catch {
          // The initial map file does not exist yet.
        }

        ModuleOdrViewer.FS.writeFile(mapPath, new TextEncoder().encode(payload), { canOwn: true });
        OpenDriveViewer.load_map(mapPath, 0.1, firstLoad, true);

        if (firstLoad) { firstLoad = false; }
      } catch (error) {
        vscode.postMessage({
          command: "error",
          message: error instanceof Error ? error.message : String(error),
          notificationId
        });
      }

      vscode.postMessage({
        command: "loadEnd",
        notificationId
      });

      if (!renderLoopStarted) {
        renderLoopStarted = true;
        render();
      }
    }

    function enqueuePayload(payload) {
      payloadQueue = payloadQueue.then(
        () => onPayload(payload.payload, payload.notificationId, payload.fileName),
        () => onPayload(payload.payload, payload.notificationId, payload.fileName)
      );
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.command == "payload") {
        const payload = {
          payload: message.payload,
          notificationId: message.notificationId,
          fileName: message.fileName
        };
        if (!ModuleOdrViewer) {
          pendingPayload.push(payload);
        } else {
          enqueuePayload(payload);
        }
      } 
    });
  
    const viewerModule = {
      wasmBinary: wasmBytes.buffer,
      print: message => odr_log_callback("INFO", message),
      printErr: message => odr_log_callback("ERROR", message),
      onAbort: message => {
        const errorMessage = "Viewer aborted: " + message;
        odr_log_callback("ERROR", errorMessage);
        vscode.postMessage({ command: "error", message: errorMessage });
      }
    };

    OdrViewer(viewerModule).then(Module => {
      ModuleOdrViewer = Module;
      ModuleOdrViewer['canvas'] = canvas;

      // Informing vscode that load is actually complete.
      vscode.postMessage({command: "load"});
      const queuedPayloads = pendingPayload;
      pendingPayload = [];
      for (const payload of queuedPayloads) {
        enqueuePayload(payload);
      }
    }).catch((error) => { 
      vscode.postMessage({
        command: "error",
        message: error instanceof Error ? error.message : String(error)
      });
    });

  </script>
</body>
</html>`;
}

module.exports = {
    getWebViewIndexHtml
};