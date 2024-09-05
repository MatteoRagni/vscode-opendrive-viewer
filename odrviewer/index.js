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
const vscode = require('vscode');

function getWebViewIndexHtml(context) {
  const viewerWasmFile = vscode.Uri.joinPath(context.extensionUri, 'odrviewer', "viewer.wasm.base64").fsPath;
  const viewerWasm = `data:application/octet-stream;base64,${fs.readFileSync(viewerWasmFile)}`;
  const viewerJsFile = vscode.Uri.joinPath(context.extensionUri, 'odrviewer', "viewer.js").fsPath;
  const viewerJs = fs.readFileSync(viewerJsFile);
  
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no">
  <style>
    .fullscreen {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }        
  </style>
</head>
<body>
  <canvas id="canvas" class="fullscreen" oncontextmenu="event.preventDefault()"></canvas>
  <script>
    const vscode = acquireVsCodeApi();
  
    // Loaded by the extension
    const ViewerWasm = (function() {
      return \`${viewerWasm}\`
    }());
    ${viewerJs}
    // End of extension loaded data

    const canvas = document.getElementById("canvas");
    (function() {
      const px_ratio = window.devicePixelRatio || 1;
      canvas.width = canvas.clientWidth * px_ratio;
      canvas.height = canvas.clientHeight * px_ratio;
    }());
    
    let OpenDriveViewer = null;
    let ModuleOdrViewer = null;
    
  
    function render() {
      OpenDriveViewer.render();
      requestAnimationFrame(render);
    };
  
    function onPayload(payload, notificationId) {
      if (!ModuleOdrViewer) return;
      if (!OpenDriveViewer) OpenDriveViewer = ModuleOdrViewer.Viewer.get_instance();
      
      vscode.postMessage({
        command: "loadStart",
        notificationId,
      });
      try {
        ModuleOdrViewer.FS.createDataFile(".", "data.xodr", payload, true, true);
        OpenDriveViewer.load_map("./data.xodr", 0.1, true);
        ModuleOdrViewer.FS.unlink("data.xodr");
      } catch (error) {
        vscode.postMessage({
          command: "error",
          message: error,
          notificationId
        });
      }

      vscode.postMessage({
        command: "loadEnd",
        notificationId
      });

      render();
    }

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.command == "payload") {
        onPayload(message.payload, message.notificationId);
      } 
    });
  
    OdrViewer().then(Module => {
      ModuleOdrViewer = Module;
      ModuleOdrViewer['canvas'] = canvas;
      // Informing vscode that load is actually complete
      vscode.postMessage({command: "load"});
    }).catch((error) => { 
      vscode.postMessage({
        command: "error",
        message: error
      })
    });

  </script>
</body>
</html>`;
}

module.exports = {
    getWebViewIndexHtml
};