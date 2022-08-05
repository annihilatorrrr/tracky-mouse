const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
	onToggle: (callback) => ipcRenderer.on('toggle', callback),
	// Note terrible naming inconsistency.
	onMouseMove: (callback) => ipcRenderer.on('move-mouse', callback),

	// This is pretty weird but I'm giving the overlay window control over clicking,
	// whereas the main window has control over moving the mouse.
	// The main window has the head tracker, which moves the mouse,
	// and the overlay window handles the dwell clicking (rendering, and, in this case, clicking).
	// It's quite the hacky architecture.
	// A more sane architecture might have the overlay window, which can't receive any input directly,
	// as purely a visual output, rather than containing business logic for handling clicks.
	// But this let me reuse my existing code for dwell clicking, without tearing it apart.

	mouseClick: (x, y) => ipcRenderer.send('click', x, y, performance.now()),
});
