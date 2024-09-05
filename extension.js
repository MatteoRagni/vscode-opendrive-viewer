const vscode = require('vscode');
const odrviewer = require("./odrviewer");
const path = require('path');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
	/**
	 * Notification utility class to handle promises of progress from the 
	 * WebView side. The progress is marked with a "unique identification"
	 * string. When the notification is complete, the id is marked as to be resolved.
	 * The notification id is a serializable value that can be shared with the 
	 * WebView component.
	 */
	class Notifications {
		constructor() {
			this.notifications = {};
		}
		/**
		 * Utility to create a new unique notification id. Collisions are
		 * checked.
		 * 
		 * @return {String} a notification identifier string
		 */
		createNotificationId() {
			while (true) {
				const nid = "nid" + Math.random().toString(16).slice(2);
				if (!this.notifications[nid]) {
					return nid;
				}
			}
		}
		/**
		 * Starts a notification with progress. Notification is marked with
		 * a notification Id and can be used to resolve its execution. Progress
		 * are not meant to be cancellable, as for now.
		 * 
		 * @param {String} notificationId the notification identifier to be used
		 * @param {String} message the message to include in the notification
		 * @param {Boolean} cancellable flag to make it cancellable (unused)
		 * @param {Number} maxDuration time after which operation times out
		 */
		notifyProgress(notificationId, message, cancellable, maxDuration) {
			if (!cancellable) { cancellable = false; }
			if (!maxDuration) { maxDuration = 30000; }

			vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: message,
				cancellable
			}, () => {
				const promise = new Promise(resolve => {
					let deleteRetryCounter = 0;

					const intervalFunction = () => {
						deleteRetryCounter += 500;
						if (deleteRetryCounter >= maxDuration) {
							this.notifications[notificationId].resolve = true;
							this.notifyError(`Operation timeout: ${message}`);
						}
						if (this.notifications[notificationId]) {
							if (this.notifications[notificationId].resolve) {
								resolve();
								delete this.notifications[notificationId];
								return;
							}
						}
						setTimeout(intervalFunction, 500);
					};

					setTimeout(intervalFunction, 500);
				});
				return promise;
			});
			this.notifications[notificationId] = {
				resolve: false
			};
		}
		/**
		 * Resolve an existing notification
		 * 
		 * @param {String} notificationId the notification to be resolved
		 */
		resolveProgress(notificationId) {
			if (this.notifications[notificationId]) {
				this.notifications[notificationId].resolve = true;
			}
		}
		/**
		 * Create a notification for errors
		 * 
		 * @param {String} message Error message
		 */
		notifyError(message) {
			vscode.window.showErrorMessage(message);
		}
	};

	/**
	 * Main application function. The applications more or less does the following.
	 * 
	 *  1. Create a webview in which OdrViewer HTML code is injected, and is attached to the
	 *     current active editor (originalEditor)
	 *  2. The extension attaches to onSave event of the workspace. The event will update the
	 *     map contained in viewer with the updated version
	 *  3. The webview, once is completely loaded, send a "load" command to extension
	 *  4. extension replies with a "payload" command to load the first map
	 */
	function openDriveViewerShow() {
		const notify = new Notifications();
		const loadNotificationId = notify.createNotificationId();
		notify.notifyProgress(loadNotificationId, "Loading ODRViewer application");
		
		const originalEditor = vscode.window.activeTextEditor;
		const activeWorkspace = vscode.workspace;

		const tabName = `${path.basename(originalEditor.document.fileName)} - ODRViewer`;		
		const panel = vscode.window.createWebviewPanel('odrviewer', tabName,
			vscode.ViewColumn.Beside, { enableScripts: true, retainContextWhenHidden: true } );
		const index = odrviewer.getWebViewIndexHtml(context);
		panel.webview.html = index;

		/**
		 * Subscribing to save event in workspace
		 */
		activeWorkspace.onDidSaveTextDocument((document) => {
			if (document.uri != originalEditor.document.uri) { return; }

			const currentNotificationId = notify.createNotificationId();
			notify.notifyProgress(currentNotificationId, `Reloading ${originalEditor.document.uri}`);

			const documentText = document.getText();
			panel.webview.postMessage({
				command: "payload",
				payload: documentText,
				notificationId: currentNotificationId
			});
		})

		const onLoad = () => {
			if (originalEditor) {
				let document = originalEditor.document;
				notify.resolveProgress(loadNotificationId);

				const currentNotificationId = notify.createNotificationId();
				notify.notifyProgress(currentNotificationId, `Loading ${document.uri}`);
				
				const documentText = document.getText();
				panel.webview.postMessage({
					command: "payload",
					payload: documentText,
					notificationId: currentNotificationId
				});
			} else {
				notify.notifyError("ODRViewer extension cannot attach to active editor");
			}
		};

		const onLoadStart = (message) => {
			// Old message, now unused
			return;
		};

		const onLoadEnd = (message) => {
			notify.resolveProgress(message.notificationId);
		};

		const onError = (message) => {
			if (message.notificationId) {
				notify.resolveProgress(message.notificationId);
			}
			notify.notifyError(message.message);
		}

		panel.webview.onDidReceiveMessage((message) => {
			switch(message.command) {
				case 'load':
					onLoad();
					break;
				case 'loadStart':
					onLoadStart(message);
					break;
				case 'loadEnd':
					onLoadEnd(message);
					break;
				case 'error':
					onError(message);
			}
		});
	};

	// Registers the commend to show the OpenDRIVE viewer panel
	const disposable = vscode.commands.registerCommand('opendrive-viewer.show', openDriveViewerShow);
	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
function deactivate() {}

module.exports = {
	activate,
	deactivate
}
