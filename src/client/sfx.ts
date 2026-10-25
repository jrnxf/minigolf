// Small synthesized sounds and haptics. Nothing plays until the first touch,
// because browsers only allow audio after a user gesture.

import { load, save } from "./storage.ts";

let ctx: AudioContext | null = null;
let enabled = load("sound") !== "off";

function audio(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(freq: number, dur: number, type: OscillatorType = "sine", gain = 0.08, slide = 0, delay = 0) {
  const a = audio();
  if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function buzz(pattern: number | number[]) {
  if (enabled && "vibrate" in navigator) navigator.vibrate(pattern);
}

export const sfx = {
  /** Call from the first pointer or click so later sounds may play. */
  unlock() {
    audio();
  },
  get enabled() {
    return enabled;
  },
  set enabled(on: boolean) {
    enabled = on;
    save("sound", on ? "on" : "off");
    if (!on) void ctx?.suspend();
  },
  putt(power: number) {
    tone(170 + power * 160, 0.1, "triangle", 0.14, 0.7);
    buzz(12);
  },
  wall(v: number) {
    tone(520, 0.04, "square", Math.min(0.05, v / 9000));
  },
  bumper(v: number) {
    tone(740, 0.12, "sine", Math.min(0.09, v / 5000), 1.6);
    buzz(8);
  },
  lip() {
    tone(1250, 0.06, "triangle", 0.06, 0.8);
  },
  sink() {
    tone(660, 0.12, "sine", 0.1);
    tone(990, 0.24, "sine", 0.1, 0, 0.11);
    buzz([20, 40, 20]);
  },
  yourTurn() {
    tone(520, 0.1, "sine", 0.07);
    tone(780, 0.16, "sine", 0.07, 0, 0.09);
    buzz([30, 60, 30]);
  },
  tick() {
    tone(900, 0.03, "sine", 0.03);
  },
};
