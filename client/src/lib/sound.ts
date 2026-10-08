// Tiny synthesized sound effects for the main screen (no audio assets needed).
import { prefs } from './storage';

let ctx: AudioContext | null = null;
let enabled = prefs.get('sound') !== 'off';

function audio(): AudioContext | null {
  if (!enabled) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, start: number, duration: number, type: OscillatorType = 'sine', gain = 0.15) {
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + start;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

export const sound = {
  get enabled() {
    return enabled;
  },
  setEnabled(on: boolean) {
    enabled = on;
    prefs.set('sound', on ? 'on' : 'off');
    if (on) audio();
  },
  /** Call from a user gesture so browsers allow audio later. */
  unlock() {
    audio();
  },
  join() {
    tone(660, 0, 0.12, 'triangle');
    tone(990, 0.08, 0.15, 'triangle');
  },
  vote() {
    tone(1200, 0, 0.05, 'square', 0.04);
  },
  tick(final = false) {
    tone(final ? 1400 : 900, 0, 0.08, 'square', 0.07);
  },
  start() {
    [392, 523, 659].forEach((f, i) => tone(f, i * 0.1, 0.2, 'sawtooth', 0.08));
  },
  reveal() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, 0.3, 'triangle', 0.15));
  },
  champion() {
    const notes = [523, 659, 784, 1047, 784, 1047, 1319];
    notes.forEach((f, i) => tone(f, i * 0.13, 0.4, 'triangle', 0.16));
  },
};
