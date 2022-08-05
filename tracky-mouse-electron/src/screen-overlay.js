
const actionSpan = document.getElementById("enable-disable");

const bigButton = document.createElement("button");
bigButton.style.position = "absolute";
bigButton.style.top = "0";
bigButton.style.left = "0";
bigButton.style.width = "100%";
bigButton.style.height = "100%";
bigButton.style.backgroundColor = "transparent";
bigButton.style.border = "none";
bigButton.id = "button-that-takes-up-the-entire-screen";
document.body.appendChild(bigButton);

TrackyMouse.initDwellClicking({
	noCenter: (el) => el.matches("#button-that-takes-up-the-entire-screen"),
	click: ({ x, y }) => {
		mouseClick(x, y);
	},
	retarget: [], // not optional?
	targets: "#button-that-takes-up-the-entire-screen",
	isEquivalentTarget: (el1, el2) => el1 === el2, // not optional??
});

window.dispatchEvent(new Event("focus"));

electronAPI.onToggle((event, isEnabled) => {
	actionSpan.innerText = isEnabled ? "disable" : "enable";
});
