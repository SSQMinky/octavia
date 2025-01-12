"use strict";

import {OctaviaDevice, allocated} from "../state/index.mjs";
import {RootDisplay, ccToPos} from "../basic/index.mjs";
import {MxFont40, MxFont176, MxBmDef} from "../basic/mxReader.js";

import {getDebugState} from "../state/utils.js";

import {
	backlight,
	inactivePixel,
	activePixel,
	lcdPixel,
	lcdCache
} from "./colour.js";

const exExhaust = 400, exDuration = 1000;

let totalWidth = 160, totalHeight = 64, totalPixelCount = totalWidth * totalHeight;

let flipBitsInBuffer = (buf, bWidth, startX, startY, width, height) => {
	let endX = startX + width, endY = startY + height;
	for (let pY = startY; pY < endY; pY ++) {
		let lineOff = pY * bWidth;
		for (let pX = startX; pX < endX; pX ++) {
			buf[lineOff + pX] = buf[lineOff + pX] ? 0 : 255;
		};
	};
};
let fillBitsInBuffer = (buf, bWidth, startX, startY, width, height, bit = 255) => {
	let endX = startX + width, endY = startY + height;
	for (let pY = startY; pY < endY; pY ++) {
		let lineOff = pY * bWidth;
		for (let pX = startX; pX < endX; pX ++) {
			buf[lineOff + pX] = bit;
		};
	};
};

let twoLetterMode = {
	"?": "  ",
	"mt32": "mt",
	"doc": "dc",
	"qy10": "qy",
	"qy20": "qy",
	"ns5r": "n5",
	"x5d": "xd",
	"05rw": "rw",
	"k11": "kg",
	"krs": "kr",
	"s90es": "es",
	"motif": "es",
	"trin": "tr"
};

let Sc8850Display = class extends RootDisplay {
	#pixelLit = 255;
	#pixelOff = 0;
	#lastBg = 0;
	#nmdb = new Uint8Array(totalPixelCount);
	#dmdb = new Uint8Array(totalPixelCount);
	#omdb = new Uint8Array(totalPixelCount);
	#linger = new Uint8Array(allocated.ch);
	#lingerExtra = new Uint8Array(allocated.ch);
	#ch = 0;
	#range = 0;
	#start = 255; // start port
	#mode = "?";
	useBlur = false;
	#scheduledEx = false;
	#unresolvedEx = false;
	#awaitEx = 0;
	#promptEx = 0;
	font55 = new MxFont40("./data/bitmaps/sc/libre55.tsv");
	font56 = new MxFont40("./data/bitmaps/sc/libre56.tsv");
	scSys = new MxBmDef("./data/bitmaps/sc/system.tsv");
	font7a = new MxFont176("./data/bitmaps/sc/libre7a.tsv");
	voxBm = new MxBmDef("./data/bitmaps/sc/voices.tsv");
	constructor(conf) {
		super(new OctaviaDevice(), 0.25, 0.5);
		let upThis = this;
		upThis.useBlur = !!conf?.useBlur;
		upThis.addEventListener("channelactive", (ev) => {
			upThis.#ch = ev.data;
		});
		upThis.addEventListener("portrange", (ev) => {
			if (ev && ev.data != 1 << Math.log2(ev.data)) {
				console.debug(`MU display rejected port range value ${ev.data}.`);
			};
			upThis.#range = ev.data;
		});
		upThis.addEventListener("portstart", (ev) => {
			if (ev != 255 && ev >= allocated.port) {
				console.debug(`MU display rejected port range value ${ev.data}.`);
			};
			upThis.#start = ev.data;
		});
		upThis.device.addEventListener("mode", (ev) => {
			upThis.#mode = ev.data;
		});
		upThis.device.addEventListener("mupromptex", () => {
			upThis.#scheduledEx = true;
			getDebugState() && console.debug(`Scheduled a SysEx prompt.`);
		});
	};
	setCh(ch) {
		this.#ch = ch;
	};
	getCh() {
		return this.#ch;
	};
	reset() {
		super.reset();
		this.#range = 0;
		this.#start = 255;
		this.#lingerExtra.fill(0);
	};
	render(time, ctx) {
		let sum = super.render(time);
		let upThis = this;
		let timeNow = Date.now();
		let fullRefresh = false;
		upThis.#nmdb.fill(0);
		// Prepare the canvas
		if (timeNow - upThis.#lastBg >= 3600000) {
			ctx.fillStyle = backlight.orange;
			ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
			upThis.#lastBg = timeNow;
			fullRefresh = true;
		};
		// Test SysEx status
		if (upThis.#scheduledEx) {
			upThis.#scheduledEx = false;
			if (timeNow - upThis.#promptEx > exExhaust) {
				upThis.#unresolvedEx = true;
				getDebugState() && console.debug(`SysEx prompt submitted.`);
			} else {
				getDebugState() && console.debug(`SysEx prompt too busy.`);
			};
			upThis.#awaitEx = timeNow;
		};
		// Channel test
		let alreadyMin = false;
		let minCh = 0, maxCh = 0;
		sum.chInUse.forEach(function (e, i) {
			if (e) {
				if (!alreadyMin) {
					alreadyMin = true;
					minCh = i;
				};
				maxCh = i;
			};
		});
		let part = minCh >> 4;
		minCh = part << 4;
		maxCh = ((maxCh >> 4) << 4) + 15;
		if (upThis.#ch > maxCh) {
			upThis.#ch = minCh + upThis.#ch & 15;
		};
		if (upThis.#ch < minCh) {
			upThis.#ch = maxCh - 15 + (upThis.#ch & 15);
		};
		if (upThis.#range) {
			if (upThis.#start == 255) {
				minCh = (Math.floor((upThis.#ch >> 4) / upThis.#range) * upThis.#range) << 4;
			} else {
				minCh = upThis.#start << 4;
			};
			maxCh = minCh + upThis.#range * 16 - 1;
		};
		let chOff = upThis.#ch * ccToPos.length;
		let rendMode = Math.ceil(Math.log2(maxCh - minCh + 1) - 4);
		//console.debug(minCh, maxCh, rendMode);
		// Render current channel
		upThis.font56.getStr(`${"ABCDEFGH"[upThis.#ch >> 4]}${`${(upThis.#ch & 15) + 1}`.padStart(2, "0")}`).forEach((e0, i0) => {
			let offsetX = i0 * 6 + 1;
			e0.forEach((e1, i1) => {
				let pX = (i1 % 5) + offsetX, pY = Math.floor(i1 / 5) + 3;
				if (e1) {
					upThis.#nmdb[pY * totalWidth + pX] = 255;
				};
			});
		});
		// Render bank info and voice name
		let voiceObject = upThis.getChVoice(upThis.#ch);
		upThis.font56.getStr(voiceObject.bank).forEach((e0, i0) => {
			let offsetX = i0 * 6 + 21;
			e0.forEach((e1, i1) => {
				let pX = (i1 % 5) + offsetX, pY = Math.floor(i1 / 5) + 3;
				if (e1) {
					upThis.#nmdb[pY * totalWidth + pX] = 255;
				};
			});
		});
		upThis.font56.getStr(`${sum.chProgr[this.#ch] + 1}`.padStart(3, "0")).forEach((e0, i0) => {
			let offsetX = i0 * 6 + 44;
			e0.forEach((e1, i1) => {
				let pX = (i1 % 5) + offsetX, pY = Math.floor(i1 / 5) + 3;
				if (e1) {
					upThis.#nmdb[pY * totalWidth + pX] = 255;
				};
			});
		});
		flipBitsInBuffer(upThis.#nmdb, totalWidth, 43, 2, 19, 8);
		upThis.font7a.getStr(upThis.getMapped(voiceObject.name).slice(0, 12).padEnd(12, " ")).forEach((e0, i0) => {
			let offsetX = i0 * 8;
			e0.forEach((e1, i1) => {
				let pX = (i1 % 11) + offsetX + 64, pY = Math.floor(i1 / 11) + 1;
				if (e1) {
					upThis.#nmdb[pY * totalWidth + pX] = 255;
				};
			});
		});
		upThis.getChBm(upThis.#ch, voiceObject)?.render((e, x, y) => {
			upThis.#nmdb[(y + 18) * totalWidth + x + 2] = e ? 255 : 0;
		});
		// Render port selection
		switch (rendMode) {
			case 0: {
				let portStart = (upThis.#ch >> 6) << 2, portNow = upThis.#ch >> 4;
				let shiftX = (portStart >> 6) & 1;
				for (let i = 0; i < 4; i ++) {
					let portWork = portStart + i;
					let portOffX = i * 40 + 2 + shiftX, portOffY = (portWork == portNow) ? 59 : 58;
					upThis.font55.getStr(`PART-${"ABCDEFGH"[portWork]}`).forEach((e0, i0) => {
						let offsetX = i0 * 6;
						e0.forEach((e1, i1) => {
							let pX = (i1 % 5) + offsetX + portOffX, pY = Math.floor(i1 / 5) + portOffY;
							if (e1) {
								upThis.#nmdb[pY * totalWidth + pX] = 255;
							};
						});
					});
					upThis.scSys.getBm(portWork == portNow ? "tabSel" : "tabIdle")?.render((e, x, y) => {
						if (e) {
							let pI = (40 * i) + x + (y + 57) * totalWidth;
							upThis.#nmdb[pI] = upThis.#nmdb[pI] ? 0 : 255;
						};
					});
				};
				break;
			};
			case 1:
			case 2:
			case 3: {
				let portNow = upThis.#ch >> 4;
				for (let i = 0; i < 4; i ++) {
					let portOffX = i * 40 + 2, portOffY = (rendMode == i) ? 59 : 58;
					let tabText = i == 3 ? "128CH" : `${16 << i}CH-${"ABCDEFGH"[minCh >> 4]}`;
					upThis.font55.getStr(tabText).forEach((e0, i0) => {
						let offsetX = i0 * 6;
						e0.forEach((e1, i1) => {
							let pX = (i1 % 5) + offsetX + portOffX, pY = Math.floor(i1 / 5) + portOffY;
							if (e1) {
								upThis.#nmdb[pY * totalWidth + pX] = 255;
							};
						});
					});
					upThis.scSys.getBm(rendMode == i ? "tabSel" : "tabIdle")?.render((e, x, y) => {
						if (e) {
							let pI = (40 * i) + x + (y + 57) * totalWidth;
							upThis.#nmdb[pI] = upThis.#nmdb[pI] ? 0 : 255;
						};
					});
				};
				break;
			};
		};
		upThis.font56.getStr("123456789\x80\x81\x82\x83\x84\x85\x86").forEach((e0, i0) => {
			let offsetX = i0 * 6;
			e0.forEach((e1, i1) => {
				let pX = (i1 % 5) + offsetX + 49, pY = Math.floor(i1 / 5) + 49;
				if (e1) {
					upThis.#nmdb[pY * totalWidth + pX] = 255;
				};
			});
		});
		switch (upThis.#mode) {
			case "?":
			case "gs":
			case "sc":
			case "gm": {
				break;
			};
			default: {
				let mode = (twoLetterMode[upThis.device.getChMode(upThis.#ch)] || upThis.device.getChMode(upThis.#ch)).toUpperCase();
				upThis.font56.getStr(mode).forEach((e0, i0) => {
					let offsetX = i0 * 6;
					e0.forEach((e1, i1) => {
						let pX = (i1 % 5) + offsetX + 148, pY = Math.floor(i1 / 5) + 49;
						if (e1) {
							upThis.#nmdb[pY * totalWidth + pX] = 255;
						};
					});
				});
				if (voiceObject.standard != "GM" && mode != voiceObject.standard) {
					upThis.font56.getStr(voiceObject.standard).forEach((e0, i0) => {
						let offsetX = i0 * 6;
						e0.forEach((e1, i1) => {
							let pX = (i1 % 5) + offsetX + 148, pY = Math.floor(i1 / 5) + 42;
							if (e1) {
								upThis.#nmdb[pY * totalWidth + pX] = 255;
							};
						});
					});
				};
				if (upThis.#unresolvedEx) {
					upThis.#unresolvedEx = false;
					upThis.#promptEx = timeNow;
					getDebugState() && console.debug(`SysEx prompt resolved.`);
				};
				let exBlink = timeNow - upThis.#promptEx;
				if (exBlink <= exDuration && !(Math.floor(exBlink / exDuration * 5) & 1)) {
					upThis.font56.getStr("Ex").forEach((e0, i0) => {
						let offsetX = i0 * 6;
						e0.forEach((e1, i1) => {
							let pX = (i1 % 5) + offsetX + 148, pY = Math.floor(i1 / 5) + 35;
							if (e1) {
								upThis.#nmdb[pY * totalWidth + pX] = 255;
							};
						});
					});
				};
				break;
			};
		};
		// Strength calculation
		let renderRange = 1 << rendMode,
		strengthHeight = (35 - renderRange + 1) / renderRange,
		strengthDivider = 256 / strengthHeight;
		sum.velo.forEach(function (e, i) {
			if (e >= upThis.#linger[i]) {
				upThis.#linger[i] = e;
				upThis.#lingerExtra[i] = 127;
			} else {
				if (upThis.#lingerExtra[i] >> 4) {
					upThis.#lingerExtra[i] -= 16;
				} else {
					let val = upThis.#linger[i] - 4 * renderRange;
					if (val < 0) {
						val = 0;
					};
					upThis.#linger[i] = val;
				};
			};
		});
		//console.debug(renderRange, strengthHeight, strengthDivider);
		// Render meters
		if (timeNow < sum.bitmap.expire) {
			// Actual bitmap
			let colUnit = (sum.bitmap.bitmap.length > 256) ? 1 : 2;
			for (let i = 0; i < 512; i += colUnit) {
				let x = i & 31, y = i >> 5;
				let realX = x * 3 + 49, realY = (y << 1) + 15;
				let bit = sum.bitmap.bitmap[i >> (colUnit - 1)] ? upThis.#pixelLit : upThis.#pixelOff;
				fillBitsInBuffer(upThis.#nmdb, totalWidth, realX, realY, 2, 2, bit);
				if (colUnit == 2) {
					fillBitsInBuffer(upThis.#nmdb, totalWidth, realX + 2, realY, 3, 2, bit);
				};
			};
		} else {
			for (let i0 = 0; i0 < renderRange; i0 ++) {
				let chStart = minCh + (i0 << 4);
				for (let i1 = 0; i1 < 16; i1 ++) {
					let ch = chStart + i1;
					let strength = Math.floor(sum.strength[ch] / strengthDivider) + 1;
					let linger = Math.floor(upThis.#linger[ch] / strengthDivider) + 1;
					fillBitsInBuffer(upThis.#nmdb, totalWidth, 49 + 6 * i1, 48 - i0 * strengthHeight - strength - i0, 5, strength);
					fillBitsInBuffer(upThis.#nmdb, totalWidth, 49 + 6 * i1, 48 - i0 * strengthHeight - linger - i0, 5, 1);
				};
			};
		};
		// EFX and bank?
		if (upThis.device.getEffectSink()[upThis.#ch]) {
			let cx = 153, cy = 12;
			upThis.scSys.getBm("efxOn")?.render((e, x, y) => {
				if (e) {
					upThis.#nmdb[cx + x + (y + cy) * totalWidth] = 255;
				};
			});
		};
		switch (upThis.device.getChMode(upThis.#ch)) {
			case "gs":
			case "sc": {
				let cc32 = sum.chContr[chOff + ccToPos[32]];
				if (cc32 > 0 && cc32 < 5) {
					let cx = 153;
					let cy = 43 - cc32 * 5;
					upThis.scSys.getBm("bankSel")?.render((e, x, y) => {
						if (e) {
							upThis.#nmdb[cx + x + (y + cy) * totalWidth] = 255;
						};
					});
				};
				break;
			};
		};
		// Guide the drawn matrix
		upThis.#nmdb.forEach((e, i) => {
			if (upThis.#dmdb[i] != e) {
				if (upThis.useBlur) {
					let diff = e - upThis.#dmdb[i],
					cap = 48;
					if (Math.abs(diff) > cap) {
						upThis.#dmdb[i] += Math.sign(diff) * cap;
					} else {
						upThis.#dmdb[i] = e;
					};
				} else {
					upThis.#dmdb[i] = e;
				};
			};
		});
		// Do the actual drawing
		upThis.#dmdb.forEach((e, i) => {
			let pX = i % totalWidth, pY = Math.floor(i / totalWidth);
			if (fullRefresh || upThis.#omdb[i] != e) {
				let posX = 4 + 5 * pX, posY = 4 + 5 * pY;
				ctx.clearRect(posX, posY, 5, 5);
				ctx.fillStyle = backlight.orange;
				ctx.fillRect(posX, posY, 5, 5);
				if (e <= upThis.#pixelOff) {
					ctx.fillStyle = lcdCache.black[3];
				} else if (e >= upThis.#pixelLit) {
					ctx.fillStyle = lcdCache.black[4];
				} else {
					ctx.fillStyle = `${lcdPixel.black}${(Math.ceil(e * lcdPixel.range / 255) + lcdPixel.inactive).toString(16)}`
				};
				ctx.fillRect(posX, posY, 4.5, 4.5);
				self.pixelUpdates = (self.pixelUpdates || 0) + 1;
			};
		});
		// Store the historical draws
		upThis.#dmdb.forEach((e, i) => {
			if (upThis.#omdb[i] != e) {
				upThis.#omdb[i] = e;
			};
		});
	};
};

export default Sc8850Display;
