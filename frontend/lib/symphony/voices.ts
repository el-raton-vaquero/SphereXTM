/**
 * StarChord star symphony — shared Web Audio voices and effects chain.
 *
 * Used by the live engine (engine.ts) and by fixed-piece playback/rendering (export.ts), so a
 * downloaded song sounds exactly like the live symphony. Works on any BaseAudioContext
 * (realtime AudioContext or OfflineAudioContext). No module-level DOM access.
 *
 *   notes ─ voiceBus ─ tone low-pass ─┬─ dry ───────────────────────────────┐
 *                                     ├─ reverb send ─ convolver ───────────┤
 *                                     └─ delay send ─ feedback delay ───────┤
 *   pad / bass / drone ─────────────────────────────────────────────────────┤
 *                       preComp ─ glue compressor ─ limiter ─ master ─ dest ◄┘
 */
import { midiToHz } from './core';

export type Voice = 'soft' | 'shimmer' | 'bell' | 'hollow' | 'breath' | 'glow';

export interface VoiceChain {
  ctx: BaseAudioContext;
  master: GainNode;
  preComp: GainNode;
  voiceBus: GainNode;
  reverbSend: GainNode;
  delaySend: GainNode;
  noise: AudioBuffer;
  hollowWave: PeriodicWave;
}

/** Build the effects chain into `dest` (master starts at `masterLevel`). */
export function buildChain(ctx: BaseAudioContext, dest: AudioNode, masterLevel = 0): VoiceChain {
  const master = ctx.createGain();
  master.gain.value = masterLevel;

  // Glue compressor then brick-wall-ish limiter: it must never clip or pump harshly.
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -20; glue.knee.value = 14; glue.ratio.value = 4; glue.attack.value = 0.01; glue.release.value = 0.3;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.12;
  const preComp = ctx.createGain();
  preComp.gain.value = 1.4;
  preComp.connect(glue).connect(limiter).connect(master).connect(dest);

  const voiceBus = ctx.createGain();
  voiceBus.gain.value = 1;
  const tone = ctx.createBiquadFilter();
  tone.type = 'lowpass'; tone.frequency.value = 4600; tone.Q.value = 0.4;
  voiceBus.connect(tone);
  const dry = ctx.createGain();
  dry.gain.value = 0.62;
  tone.connect(dry).connect(preComp);

  // Reverb: long, dark, generated impulse response.
  const reverbSend = ctx.createGain();
  reverbSend.gain.value = 0.7;
  const conv = ctx.createConvolver();
  conv.buffer = makeImpulse(ctx, 4.2);
  const verbHp = ctx.createBiquadFilter();
  verbHp.type = 'highpass'; verbHp.frequency.value = 140;
  const verbRet = ctx.createGain();
  verbRet.gain.value = 0.75;
  tone.connect(reverbSend);
  reverbSend.connect(verbHp).connect(conv).connect(verbRet).connect(preComp);

  // Feedback delay (dotted-eighth feel), filtered so repeats get darker.
  const delaySend = ctx.createGain();
  delaySend.gain.value = 0.2;
  const delay = ctx.createDelay(2);
  delay.delayTime.value = 0.39;
  const dlp = ctx.createBiquadFilter();
  dlp.type = 'lowpass'; dlp.frequency.value = 2200;
  const fb = ctx.createGain();
  fb.gain.value = 0.36;
  tone.connect(delaySend).connect(delay).connect(dlp).connect(fb).connect(delay);
  const dRet = ctx.createGain();
  dRet.gain.value = 0.55;
  dlp.connect(dRet).connect(preComp);
  dlp.connect(reverbSend);

  // Shared noise buffer (breath voice) and odd-harmonic wave (hollow voice).
  const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const real = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const imag = new Float32Array([0, 1, 0, 0.3, 0, 0.14, 0, 0.06, 0]);
  const hollowWave = ctx.createPeriodicWave(real, imag);

  return { ctx, master, preComp, voiceBus, reverbSend, delaySend, noise, hollowWave };
}

export function makeImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const ir = ctx.createBuffer(2, len, rate);
  const pre = Math.floor(rate * 0.025);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / (len - pre);
      // Progressive one-pole low-pass: the tail darkens as it decays.
      const k = 0.55 - 0.45 * t;
      lp += k * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * Math.pow(1 - t, 2.2) * Math.exp(-3.2 * t);
    }
  }
  return ir;
}

/**
 * One melodic note (the live symphony's note voices). Returns its sources (already scheduled
 * to start at `at` and stop shortly after the release) so a caller can cut them early.
 */
export function playVoice(
  chain: VoiceChain, at: number, midi: number, vel: number, dur: number, panValue: number, voice: Voice,
): AudioScheduledSourceNode[] {
  const ctx = chain.ctx;
  const f = midiToHz(midi);
  // Equal-loudness-ish tilt: high notes softer so the top never gets shrill.
  const tilt = 1 - 0.45 * Math.min(1, Math.max(0, (midi - 60) / 40));
  const peak = 0.11 * vel * tilt;
  const attack = voice === 'shimmer' || voice === 'glow' ? 0.18 : voice === 'bell' ? 0.006 : 0.035 + (1 - vel) * 0.05;
  const end = at + dur;
  const out = ctx.createGain();
  out.gain.setValueAtTime(0, at);
  out.gain.linearRampToValueAtTime(peak, at + attack);
  out.gain.setTargetAtTime(0, at + attack, Math.max(0.08, (dur - attack) / 3.2));
  const pan = ctx.createStereoPanner();
  pan.pan.value = panValue;
  out.connect(pan).connect(chain.voiceBus);
  const srcs: AudioScheduledSourceNode[] = [];
  const osc = (hz: number, type: OscillatorType = 'sine', det = 0, lvl = 1) => {
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = hz; o.detune.value = det;
    if (lvl !== 1) { const g = ctx.createGain(); g.gain.value = lvl; o.connect(g).connect(out); } else o.connect(out);
    srcs.push(o);
    return o;
  };
  const fm = (carrier: OscillatorNode, ratio: number, index: number, decay: number) => {
    const m = ctx.createOscillator();
    m.frequency.value = f * ratio;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(f * index, at);
    mg.gain.setTargetAtTime(0, at + 0.01, decay);
    m.connect(mg).connect(carrier.frequency);
    srcs.push(m);
  };
  switch (voice) {
    case 'soft': {
      const c = osc(f);
      fm(c, 2, 0.9 * vel, Math.max(0.08, dur * 0.25));
      osc(f * 2, 'sine', 4, 0.12);
      break;
    }
    case 'shimmer': {
      osc(f, 'sine', -8, 0.5); osc(f, 'sine', 8, 0.5);
      osc(f * 2, 'sine', 5, 0.18); osc(f * 3, 'sine', -6, 0.07);
      break;
    }
    case 'bell': {
      const c = osc(f, 'sine', 0, 0.8);
      fm(c, 3.5, 2.2 * vel, 0.18);
      osc(f * 2.76, 'sine', 0, 0.12);
      break;
    }
    case 'hollow': {
      const o = ctx.createOscillator();
      o.setPeriodicWave(chain.hollowWave); o.frequency.value = f;
      const g = ctx.createGain(); g.gain.value = 0.7;
      o.connect(g).connect(out); srcs.push(o);
      break;
    }
    case 'breath': {
      osc(f, 'sine', 0, 0.55);
      const n = ctx.createBufferSource(); n.buffer = chain.noise; n.loop = true;
      n.loopStart = Math.random(); n.loopEnd = n.loopStart + 0.9;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = 25;
      const g = ctx.createGain(); g.gain.value = 3.2;
      n.connect(bp).connect(g).connect(out); srcs.push(n);
      break;
    }
    case 'glow': {
      osc(f, 'sine', 0, 0.6); osc(f * 1.5, 'sine', 3, 0.25); osc(f * 2, 'triangle', 0, 0.06);
      break;
    }
  }
  const stopAt = end + 0.4;
  for (const s of srcs) { s.start(at); s.stop(stopAt); }
  srcs[0].onended = () => { try { out.disconnect(); pan.disconnect(); } catch { /* */ } };
  return srcs;
}

/**
 * Sustained pad / bass notes for a fixed piece, built like the live drone (detuned saws +
 * triangle + sine through a dark low-pass, into the compressor and the reverb). `vel` 0..1.
 */
export function playPadNote(
  chain: VoiceChain, at: number, midi: number, vel: number, dur: number, panValue: number, kind: 'pad' | 'bass',
): AudioScheduledSourceNode[] {
  const ctx = chain.ctx;
  const f = midiToHz(midi);
  const out = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.Q.value = 0.7;
  const pan = ctx.createStereoPanner();
  pan.pan.value = panValue;
  const srcs: AudioScheduledSourceNode[] = [];
  const osc = (hz: number, type: OscillatorType, det: number, lvl: number) => {
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = hz; o.detune.value = det;
    const g = ctx.createGain(); g.gain.value = lvl;
    o.connect(g).connect(lp);
    srcs.push(o);
  };
  let release: number;
  if (kind === 'pad') {
    // Same partials and levels as the live drone, one chord tone per note.
    osc(f, 'sawtooth', -7, 0.32); osc(f, 'sawtooth', 7, 0.32); osc(f * 2, 'sine', 3, 0.14);
    // The filter opens and closes slowly over the note (the live drone's LFO, one breath per chord).
    lp.frequency.setValueAtTime(330, at);
    lp.frequency.linearRampToValueAtTime(740, at + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(420, at + dur);
    const attack = Math.min(2.5, Math.max(0.3, dur * 0.3));
    release = Math.min(3, Math.max(0.4, dur * 0.3));
    const peak = 0.085 * vel;
    out.gain.setValueAtTime(0, at);
    out.gain.linearRampToValueAtTime(peak, at + attack);
    out.gain.setValueAtTime(peak, Math.max(at + attack, at + dur - release));
    out.gain.linearRampToValueAtTime(0, at + dur);
  } else {
    osc(f, 'triangle', 0, 0.55); osc(f * 2, 'sine', 0, 0.22);
    lp.frequency.value = 520;
    release = 0.25;
    const peak = 0.16 * vel;
    out.gain.setValueAtTime(0, at);
    out.gain.linearRampToValueAtTime(peak, at + 0.05);
    out.gain.linearRampToValueAtTime(peak * 0.5, Math.max(at + 0.06, at + dur - release));
    out.gain.linearRampToValueAtTime(0, Math.max(at + 0.07, at + dur));
  }
  lp.connect(out).connect(pan);
  pan.connect(chain.preComp);
  const send = ctx.createGain();
  send.gain.value = kind === 'pad' ? 1 : 0.35;
  pan.connect(send).connect(chain.reverbSend);
  const stopAt = at + dur + 0.05;
  for (const s of srcs) { s.start(at); s.stop(stopAt); }
  srcs[0].onended = () => { try { out.disconnect(); pan.disconnect(); send.disconnect(); } catch { /* */ } };
  return srcs;
}
