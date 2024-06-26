const { app, globalShortcut, dialog, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
	app.quit(); // does not exit immediately!
	return; // important!
}

// Don't require any third-party (or own) modules until after squirrel events are handled.
// If anything goes wrong, it's very bad for it to go wrong during installation and uninstallation!
const windowStateKeeper = require('electron-window-state');
const { setMouseLocation: setMouseLocationWithoutTracking, getMouseLocation, click } = require('serenade-driver');

require("./menus.js"); //({ loadSettings });

// Allow recovering from WebGL crash unlimited times.
// (To test the recovery, I've been using Ctrl+Alt+F1 and Ctrl+Alt+F2 in Ubuntu.
// Note, if Ctrl + Alt + F2 doesn't get you back, try Ctrl+Alt+F7.)
app.commandLine.appendSwitch("--disable-gpu-process-crash-limit");

// Needed for run-at-login on Windows. This is used as the registry key name.
app.setAppUserModelId("io.isaiahodhner.tracky-mouse");

// Settings
// (actual defaults come from the HTML template)
let swapMouseButtons = undefined; // for left-handed users on Windows, where serenade-driver is affected by the system setting
let mirror = undefined;
let sensitivityX = undefined;
let sensitivityY = undefined;
let acceleration = undefined;
let startEnabled = undefined;
let runAtLogin = undefined;

const settingsFile = path.join(app.getPath('userData'), 'tracky-mouse-settings.json');
const formatName = "tracky-mouse-settings";
const formatVersion = 1;

async function loadSettings() {
	let data;
	try {
		data = await fs.readFile(settingsFile, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') {
			return;
		}
		throw error;
	}
	const settings = JSON.parse(data);
	if (settings.formatName !== formatName) {
		throw new Error("Settings file format name doesn't match");
	}
	// Upgrade settings here
	// e.g.:
	// if (settings.formatVersion === 0) {
	// 	settings.formatVersion++;
	// 	settings.newSettingName = settings.someOldSettingName;
	// 	delete settings.someOldSettingName;
	// }
	if (settings.formatVersion < formatVersion) {
		throw new Error(`Unsupported settings file format version. There is no upgrade path from ${settings.formatVersion} to ${formatVersion}.`);
	}
	if (settings.formatVersion > formatVersion) {
		throw new Error(`Unsupported settings file format version (${settings.formatVersion}). This version of the app only supports up to format version ${formatVersion}.`);
	}
	deserializeSettings(settings);
}
async function saveSettings() {
	await fs.writeFile(settingsFile, JSON.stringify(serializeSettings(), null, '\t'));
}
function serializeSettings() {
	// TODO: DRY with serializeSettings in tracky-mouse.js
	return {
		formatVersion,
		formatName,
		globalSettings: {
			startEnabled,
			runAtLogin,
			swapMouseButtons,
			mirrorCameraView: mirror,
			headTrackingSensitivityX: sensitivityX,
			headTrackingSensitivityY: sensitivityY,
			headTrackingAcceleration: acceleration,
			// TODO:
			// eyeTrackingSensitivityX,
			// eyeTrackingSensitivityY,
			// eyeTrackingAcceleration,
		},
		// profiles: [],
	};
};
function deserializeSettings(settings) {
	// TODO: DRY with deserializeSettings in tracky-mouse.js
	// Handles partial settings objects,
	// to allow manually editing the settings file, removing settings to reset them to their defaults,
	// as well as accepting settings updates over IPC from the UI.
	if ("globalSettings" in settings) {
		// Don't use `in` here. Must ignore `undefined` values for the settings to default to the HTML template's defaults in the Electron app.
		if (settings.globalSettings.swapMouseButtons !== undefined) {
			swapMouseButtons = settings.globalSettings.swapMouseButtons;
		}
		if (settings.globalSettings.mirrorCameraView !== undefined) {
			mirror = settings.globalSettings.mirrorCameraView;
		}
		if (settings.globalSettings.headTrackingSensitivityX !== undefined) {
			sensitivityX = settings.globalSettings.headTrackingSensitivityX;
		}
		if (settings.globalSettings.headTrackingSensitivityY !== undefined) {
			sensitivityY = settings.globalSettings.headTrackingSensitivityY;
		}
		if (settings.globalSettings.headTrackingAcceleration !== undefined) {
			acceleration = settings.globalSettings.headTrackingAcceleration;
		}
		if (settings.globalSettings.startEnabled !== undefined) {
			startEnabled = settings.globalSettings.startEnabled;
		}
		if (settings.globalSettings.runAtLogin !== undefined) {
			runAtLogin = settings.globalSettings.runAtLogin;
			if (app.isPackaged) {
				if (process.platform === 'win32') {
					// Handle Squirrel installer on Windows.
					// It places the app in a subdirectory, with a version number, but Update.exe can be used to launch the app.
					const appFolder = path.dirname(process.execPath);
					const updateExe = path.resolve(appFolder, '..', 'Update.exe');
					const exeName = path.basename(process.execPath);

					app.setLoginItemSettings({
						openAtLogin: runAtLogin,
						path: updateExe,
						args: [
							'--processStart', `"${exeName}"`,
							'--process-start-args', '"--hidden"',
						]
					});
				} else {
					app.setLoginItemSettings({
						openAtLogin: runAtLogin,
					});
				}
			} else {
				// console.log("Ignoring runAtLogin setting because the app is not packaged.");
				// Could maybe try to pass it arguments to run the app in development mode, but it might not be worth it.
			}
		}
	}
}

// setMouseLocation/getMouseLocation are asynchronous,
// which means we have to be smart about detecting manual mouse movement.
// We don't want to pause the mouse control due to head tracker based movement.
// So instead of detecting a distance from the last mouse position,
// we'll check against a history of positions.
// How long should the queue be? Points could be removed when setMouseLocation resolves,
// if and only if it's guaranteed that getMouseLocation will return the new position at that point.
// However, a simple time limit should be fine.
const mousePosHistoryDuration = 5000; // in milliseconds; affects time to switch back to camera control after manual mouse movement (although maybe it shouldn't)
const mousePosHistory = [];
async function setMouseLocationTracky(x, y) {
	const time = performance.now();
	mousePosHistory.push({ point: { x, y }, time });
	// Test robustness using this artificial delay:
	// await new Promise((resolve) => setTimeout(resolve, Math.random() * 100));
	await setMouseLocationWithoutTracking(x, y);
}
function pruneMousePosHistory() {
	const now = performance.now();
	while (mousePosHistory[0] && now - mousePosHistory[0].time > mousePosHistoryDuration) {
		mousePosHistory.shift();
	}
}


/** @type {BrowserWindow} */
let appWindow;
/** @type {BrowserWindow} */
let screenOverlayWindow;

const createWindow = () => {
	const appWindowState = windowStateKeeper({
		defaultWidth: 750,
		defaultHeight: 700,
	});

	// Create the browser window.
	appWindow = new BrowserWindow({
		x: appWindowState.x,
		y: appWindowState.y,
		width: appWindowState.width,
		height: appWindowState.height,
		webPreferences: {
			preload: path.join(app.getAppPath(), 'src/preload-app-window.js'),
			// Disable throttling of animations and timers so the mouse control can still work when minimized.
			backgroundThrottling: false,
		},
		icon: `${__dirname}/../images/tracky-mouse-logo-512.png`,
	});

	// and load the html page of the app.
	appWindow.loadFile(`src/electron-app.html`);

	// Toggle the DevTools with F12
	appWindow.webContents.on("before-input-event", (_e, input) => {
		if (input.type === "keyDown" && input.key === "F12") {
			appWindow.webContents.toggleDevTools();

			appWindow.webContents.on('devtools-opened', async () => {
				// Can't use appWindow.webContents.devToolsWebContents.on("before-input-event") - it just doesn't intercept any events.
				await appWindow.webContents.devToolsWebContents.executeJavaScript(`
					new Promise((resolve)=> {
						addEventListener("keydown", (event) => {
							if (event.key === "F12") {
								resolve();
							}
						}, { once: true });
					})
				`);
				appWindow.webContents.toggleDevTools();
			});
		}
	});

	// Restore window state, and listen for window state changes.
	appWindowState.manage(appWindow);

	// Clean up overlay when the app window is closed.
	appWindow.on('closed', () => {
		appWindow = null; // not needed if calling app.exit(), which exits immediately, but useful if calling other methods to quit
		// screenOverlayWindow?.close(); // doesn't work because screenOverlayWindow.closable is false
		// app.quit(); // doesn't work either, because screenOverlayWindow.closable is false
		app.exit(); // doesn't call beforeunload and unload listeners, or before-quit or will-quit
		// Note: if re-assessing this, for macOS, make sure to handle the global shortcut, when the window doesn't exist.
	});

	// Expose functionality to the renderer processes.

	// Allow controlling the mouse, but pause if the mouse is moved normally.
	const thresholdToRegainControl = 10; // in pixels
	const regainControlForTime = 2000; // in milliseconds, AFTER the mouse hasn't moved for more than mouseMoveRequestHistoryDuration milliseconds (I think)
	let regainControlTimeout = null; // also used to check if we're pausing temporarily
	let enabled = true; // for starting/stopping until the user requests otherwise
	let cameraFeedDiagnostics = {};
	const updateDwellClicking = () => {
		screenOverlayWindow.webContents.send(
			'change-dwell-clicking',
			enabled && regainControlTimeout === null,
			enabled && regainControlTimeout !== null,
			cameraFeedDiagnostics,
		);
	};
	ipcMain.on('move-mouse', async (_event, x, y, time) => {
		// TODO: consider postponing getMouseLocation, if possible, to minimize latency,
		// perhaps separating logic for pausing/resuming camera control out from the camera control itself.
		const curPos = await getMouseLocation();
		// Assume any point in setMouseLocationHistory may be the latest that the mouse has been moved to,
		// since setMouseLocation is asynchronous,
		// or that getMouseLocation's result may be outdated and we've moved the mouse since then,
		// since getMouseLocation is asynchronous.
		pruneMousePosHistory();
		const distances = mousePosHistory.map(({ point }) => Math.hypot(curPos.x - point.x, curPos.y - point.y));
		const distanceMoved = distances.length ? Math.min(...distances) : 0;
		// console.log("distanceMoved", distanceMoved);
		if (distanceMoved > thresholdToRegainControl) {
			// if (regainControlTimeout === null) {
			// 	console.log("mousePosHistory", mousePosHistory);
			// 	console.log("distances", distances);
			// 	console.log("distanceMoved", distanceMoved, ">", thresholdToRegainControl, "curPos", curPos, "last pos", mousePosHistory[mousePosHistory.length - 1], "mousePosHistory.length", mousePosHistory.length);
			// 	console.log("Pausing camera control due to manual mouse movement.");
			// }
			clearTimeout(regainControlTimeout);
			regainControlTimeout = setTimeout(() => {
				regainControlTimeout = null; // used to check if we're pausing
				// console.log("Mouse not moved for", regainControlForTime, "ms; resuming.");
				updateDwellClicking();
			}, regainControlForTime);
			updateDwellClicking();
			// Prevent immediately returning to manual control after switching to camera control
			// based on head movement while in manual control mode.
			// This is one of two places where we add the RETRIEVED system mouse position to `mousePosHistory`.
			// It may be a good idea to split `mousePosHistory` into two arrays,
			// say `setMouseLocationHistory` and `getMouseLocationHistory`,
			// in order to handle maintaining manual control differently from switching to manual control,
			// and/or for clarity of intent.
			mousePosHistory.push({ point: { x: curPos.x, y: curPos.y }, time: performance.now(), from: "move-mouse" });
		} else if (regainControlTimeout === null && enabled) { // (shouldn't really get this event if enabled is false)
			// Note: there's no await here, not necessarily for a particular reason,
			// although maybe it's better to send the 'move-mouse' event as soon as possible?
			setMouseLocationTracky(x, y);
		}
		// const latency = performance.now() - time;
		// console.log(`move-mouse: (${x}, ${y}), latency: ${latency}, distanceMoved: ${distanceMoved}, curPos: (${curPos.x}, ${curPos.y}), lastPos: (${lastPos.x}, ${lastPos.y})`);

		screenOverlayWindow.webContents.send('move-mouse', x, y, time);
	});

	ipcMain.on('notify-toggle-state', async (_event, nowEnabled) => {
		let initialPos;
		if (nowEnabled) { // don't rely on getMouseLocation when disabling the software
			initialPos = await getMouseLocation();
		}
		enabled = nowEnabled;
		updateDwellClicking();

		// Start immediately if enabled.
		clearTimeout(regainControlTimeout);
		regainControlTimeout = null;
		mousePosHistory.length = 0;
		if (nowEnabled) {
			// Avoid false positive for manual takeback.
			mousePosHistory.push({ point: { x: initialPos.x, y: initialPos.y }, time: performance.now(), from: "notify-toggle-state" });
		}
	});
	ipcMain.on('notify-camera-feed-diagnostics', (_event, data) => {
		cameraFeedDiagnostics = data;
		updateDwellClicking();
	});


	ipcMain.on('set-options', (_event, newOptions) => {
		deserializeSettings(newOptions);
		saveSettings();
	});

	ipcMain.handle('get-options', async () => {
		return serializeSettings();
	});

	ipcMain.handle('get-is-packaged', async () => {
		return app.isPackaged;
	});

	ipcMain.on('click', async (_event, x, y, _time) => {
		if (regainControlTimeout || !enabled) {
			return;
		}

		// Failsafe: don't click if the window(s) are closed.
		// This helps with debugging the closing/quitting behavior.
		// It would also help to have a heartbeat to avoid clicking while paused in the debugger in other scenarios,
		// and avoid the dwell clicking indicator from repeatedly showing while there's no connectivity between the processes.
		if (
			(!screenOverlayWindow || screenOverlayWindow.isDestroyed()) ||
			(!appWindow || appWindow.isDestroyed())
		) {
			return;
		}

		// Translate coords in case of debug (doesn't matter when it's fullscreen).
		x += screenOverlayWindow.getContentBounds().x;
		y += screenOverlayWindow.getContentBounds().y;

		await setMouseLocationTracky(x, y);
		await click(swapMouseButtons ? "right" : "left");

		// const latency = performance.now() - time;
		// console.log(`click: ${x}, ${y}, latency: ${latency}`);
	});

	// Set up the screen overlay window.
	// We cannot require the screen module until the app is ready.
	const { screen } = require('electron');
	const primaryDisplay = screen.getPrimaryDisplay();
	screenOverlayWindow = new BrowserWindow({
		fullscreen: true, // needed on Windows 11, since it seems to constrain the size to the work area otherwise
		x: primaryDisplay.bounds.x,
		y: primaryDisplay.bounds.y,
		width: primaryDisplay.bounds.width,
		height: primaryDisplay.bounds.height,
		frame: false,
		transparent: true,
		backgroundColor: '#00000000',
		hasShadow: false,
		roundedCorners: false,
		alwaysOnTop: true,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		closable: false,
		focusable: false,
		skipTaskbar: true,
		accessibleTitle: 'Tracky Mouse Screen Overlay',
		webPreferences: {
			preload: path.join(app.getAppPath(), 'src/preload-screen-overlay.js'),
		},
	});
	screenOverlayWindow.setIgnoreMouseEvents(true);
	screenOverlayWindow.setAlwaysOnTop(true, 'screen-saver');

	screenOverlayWindow.loadFile(`src/electron-screen-overlay.html`);
	screenOverlayWindow.on('close', (event) => {
		// If Windows Explorer is restarted while the app is running,
		// the Screen Overlay Window can appear in the taskbar, and become closable.
		// Various window attributes are forgotten, so we need to reset them.
		// A more proactive approach of restoring skipTaskbar when Windows Explorer is restarted would be better.
		// See: https://github.com/1j01/tracky-mouse/issues/47
		// And: https://github.com/electron/electron/issues/29526
		event.preventDefault();
		screenOverlayWindow.setSkipTaskbar(true);
		screenOverlayWindow.setClosable(false);
		screenOverlayWindow.setFullScreen(true);
		screenOverlayWindow.setIgnoreMouseEvents(true);
		// "screen-saver" is the highest level; it should show above the taskbar.
		screenOverlayWindow.setAlwaysOnTop(true, 'screen-saver');
		// The window isn't showing on top of the taskbar without this.
		screenOverlayWindow.hide();
		screenOverlayWindow.show();
	});
	screenOverlayWindow.on('closed', () => {
		screenOverlayWindow = null;
	});

	// screenOverlayWindow.webContents.openDevTools({ mode: 'detach' });
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', async () => {
	try {
		await loadSettings();
	} catch (error) {
		// TODO: copy file to a backup location, and continue with default settings
		console.error("Failed to load settings:", error);
		dialog.showErrorBox("Failed to load settings", `Failed to load settings. The app will now quit.\n\n${error.message}`);
		app.quit();
		return;
	}
	createWindow();

	const success = globalShortcut.register('F9', () => {
		// console.log('Toggle tracking');
		appWindow.webContents.send("shortcut", "toggle-tracking");
	});
	if (!success) {
		dialog.showErrorBox("Failed to register shortcut", "Failed to register global shortcut F9. You'll need to pause from within the app.");
	}
});

// Prevent multiple instances of the app
if (!app.requestSingleInstanceLock()) {
	app.quit();
}

app.on('second-instance', () => {
	if (appWindow) {
		if (appWindow.isMinimized()) {
			appWindow.restore();
		}

		appWindow.show();
	}
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
// NOTE: currently exiting with app.exit()
// If re-assessing this, for macOS, make sure to handle the global shortcut, when the window doesn't exist.
app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('activate', () => {
	// On OS X it's common to re-create a window in the app when the
	// dock icon is clicked and there are no other windows open.
	if (BrowserWindow.getAllWindows().length === 0) {
		createWindow();
	}
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
