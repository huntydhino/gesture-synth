import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

// ---- DOM references ----
const videoEl = document.getElementById("webcam");
const canvasEl = document.getElementById("overlay");
const ctx = canvasEl.getContext("2d");

const gestureGuideEl = document.getElementById("gestureGuide");
const guideToggleEl = document.getElementById("guideToggle");
const chordDisplayEl = document.getElementById("chordDisplay");
const volumeBarEls = Array.from(document.querySelectorAll(".vol-bar"));
const qualityDisplayEl = document.getElementById("qualityDisplay");
const startOverlayEl = document.getElementById("startOverlay");
const startStatusEl = document.getElementById("startStatus");
const drumButton = document.getElementById("drumButton");
const drumPanel = document.getElementById("drumPanel");
const closeDrumPanel = document.getElementById("closeDrumPanel");
const drumGrid = document.getElementById("drumGrid");
const drumBpmInput = document.getElementById("drumBpm");
const drumStatus = document.getElementById("drumStatus");
const playDrumsButton = document.getElementById("playDrums");

function trackClarityEvent(eventName) {
  if (typeof window.clarity === "function") {
    window.clarity("event", eventName);
  }
}

// NEW
const helpButton = document.getElementById("helpButton");
const helpModal = document.getElementById("helpModal");
const closeHelp = document.getElementById("closeHelp");
const lyricsButton = document.getElementById("lyricsButton");
const lyricsPanel = document.getElementById("lyricsPanel");
const closeLyrics = document.getElementById("closeLyrics");
const lyricsSearchForm = document.getElementById("lyricsSearchForm");
const lyricsQuery = document.getElementById("lyricsQuery");
const lyricsStatus = document.getElementById("lyricsStatus");
const lyricsResults = document.getElementById("lyricsResults");
const karaokeOverlay = document.getElementById("karaokeOverlay");
const karaokeLines = document.getElementById("karaokeLines");
const karaokeToggle = document.getElementById("karaokeToggle");
const closeKaraoke = document.getElementById("closeKaraoke");

// ---- Finger landmark indices ----
const FINGERS = {
  index:  { pip: 6, tip: 8 },
  middle: { pip: 10, tip: 12 },
  ring:   { pip: 14, tip: 16 },
  pinky:  { pip: 18, tip: 20 },
};

function isFingerExtended(landmarks, name) {
  const { pip, tip } = FINGERS[name];
  return landmarks[tip].y < landmarks[pip].y;
}

function isThumbExtended(landmarks, handedness) {
  const thumbTip = landmarks[4];
  const thumbIp = landmarks[3];

  if (handedness === "Right") {
    return thumbTip.x > thumbIp.x;
  } else {
    return thumbTip.x < thumbIp.x;
  }
}

function getChordQuality(landmarks) {
  const wrist = landmarks[0];
  const middleMcp = landmarks[9]; // middle finger MCP joint
  return middleMcp.x > wrist.x ? "minor" : "major";
}

function classifyChord(landmarks, handedness) {
  const thumb = isThumbExtended(landmarks, handedness);
  const index = isFingerExtended(landmarks, "index");
  const middle = isFingerExtended(landmarks, "middle");
  const ring = isFingerExtended(landmarks, "ring");
  const pinky = isFingerExtended(landmarks, "pinky");

  const quality = getChordQuality(landmarks);

  if (index && pinky && !middle && !ring && !thumb) {
    return quality === "major" ? "VI" : "vi";
  }

  if (index && pinky && !middle && !ring && thumb) {
    return quality === "major" ? "VII" : "vii";
  }

  const count = [thumb, index, middle, ring, pinky].filter(Boolean).length;
  const ROMAN = { 1: "I", 2: "II", 3: "III", 4: "IV", 5: "V" };
  const base = ROMAN[count];
  if (!base) return null;

  return quality === "major" ? base : base.toLowerCase();
}

function getHandHorizontalTilt(landmarks, handedness) {
  // Safe structure guardrails to prevent engine freezing
  if (!landmarks || typeof landmarks.length === "undefined" || landmarks.length < 18) {
    return 0;
  }

  try {
    const wrist = landmarks[0];     // Wrist Base
    const middleMcp = landmarks[9];  // Middle Knuckle (Left pillar)
    const ringMcp = landmarks[13];  // Ring Knuckle (Right pillar)

    if (!wrist || !middleMcp || !ringMcp) return 0;

    // Determine the left boundary and right boundary in coordinate space
    const minX = Math.min(middleMcp.x, ringMcp.x);
    const maxX = Math.max(middleMcp.x, ringMcp.x);

    let tiltFactor = 0;
    // Max travel distance past the boundaries before hitting 100%
    const MAX_TRAVEL = 0.12; 

    if (wrist.x < minX) {
      // Wrist has slipped out to the left of the hand structure
      tiltFactor = (wrist.x - minX) / MAX_TRAVEL;
    } else if (wrist.x > maxX) {
      // Wrist has slipped out to the right of the hand structure
      tiltFactor = (wrist.x - maxX) / MAX_TRAVEL;
    } else {
      // Wrist is safely between the knuckles -> Dead-zone active!
      tiltFactor = 0;
    }

    // Clamp value safely between -1.0 and 1.0
    tiltFactor = Math.max(-1, Math.min(1, tiltFactor));

    // Keep your working structural layout rule for right-hand inversion
    if (handedness === "Right") {
      tiltFactor = -tiltFactor;
    }

    return tiltFactor;

  } catch (error) {
    console.error("Buffered tilt calculation failed:", error);
    return 0;
  }
}

// ---- Independent Gesture Stabilizers ----

// Musical state: needs confidence before changing
const CHORD_HOLD_TIME_MS = 100;

// Expression controls: should feel immediate
const VIBE_NULL_WINDOW_MS = 50;
// ============================
// CHORD STATE STABILIZER
// ============================

let stableChordState = null;
let candidateChordState = null;
let candidateChordSince = 0;
let lastChordSeenValidTime = 0;


function sameChordState(a, b) {

  if (a === null && b === null) return true;
  if (a === null || b === null) return false;

  return (
    a.chord === b.chord &&
    a.isMajorMode === b.isMajorMode &&
    a.qualityIndex === b.qualityIndex &&
    a.thumbDown === b.thumbDown
  );
}


function stabilizeChordState(rawState, now) {

  if (rawState !== null) {
    lastChordSeenValidTime = now;
  }


  let effectiveState = rawState;


  // prevent MediaPipe flicker
  if (
    rawState === null &&
    now - lastChordSeenValidTime < VIBE_NULL_WINDOW_MS
  ) {
    effectiveState = candidateChordState;
  }


  if (
    !sameChordState(
      effectiveState,
      candidateChordState
    )
  ) {

    candidateChordState = effectiveState;
    candidateChordSince = now;

  }


  if (
    now - candidateChordSince >= CHORD_HOLD_TIME_MS
  ) {

    stableChordState = candidateChordState;

  }


  return stableChordState;
}

// ---- Right hand: volume from height ----
function getVolumeFromHeight(landmarks) {
  const wrist = landmarks[0];
  const TOP = 0.05;
  const BOTTOM = 0.95;

  const clamped = Math.max(TOP, Math.min(BOTTOM, wrist.y));
  const t = (clamped - TOP) / (BOTTOM - TOP);
  return 1 - t;
}

function updateVolumeMeter(volume01) {
  const litCount = Math.round(volume01 * volumeBarEls.length);
  volumeBarEls.forEach((bar) => {
    const index = Number(bar.dataset.index);
    bar.classList.toggle("lit", index >= volumeBarEls.length - litCount);
  });
}

// ---- Right hand: quality (1-4 fingers = major, minor, dominant, diminished) ----
function getRightHandQualityIndex(landmarks) {
  const index = isFingerExtended(landmarks, "index");
  const middle = isFingerExtended(landmarks, "middle");
  const ring = isFingerExtended(landmarks, "ring");
  const pinky = isFingerExtended(landmarks, "pinky");

  return [index, middle, ring, pinky].filter(Boolean).length;
}


// ---- Camera setup ----
async function setupCamera() {
  if (!window.isSecureContext) {
    throw new Error("camera-insecure-context");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("camera-unavailable");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 480 },
    audio: false,
  });
  videoEl.srcObject = stream;
  return new Promise((resolve) => {
    videoEl.onloadedmetadata = () => {
      videoEl.play();
      resolve();
    };
  });
}



// ---- MediaPipe setup ----
async function setupHandLandmarker() {
  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
  );
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    numHands: 2,
  });
}

// ADD THIS
const GESTURE_GUIDE = [
  { degree: 1, gesture: "one" },
  { degree: 2, gesture: "two" },
  { degree: 3, gesture: "three" },
  { degree: 4, gesture: "four" },
  { degree: 5, gesture: "five" },
  { degree: 6, gesture: "pinky + index" },
  { degree: 7, gesture: "pinky + index + thumb" }
];

const MAJOR_SCALE = {
  A:  ["A","B","C#","D","E","F#","G#"],
  Bb: ["Bb","C","D","Eb","F","G","A"],
  B:  ["B","C#","D#","E","F#","G#","A#"],
  C:  ["C","D","E","F","G","A","B"],
  Db: ["Db","Eb","F","Gb","Ab","Bb","C"],
  D:  ["D","E","F#","G","A","B","C#"],
  Eb: ["Eb","F","G","Ab","Bb","C","D"],
  E:  ["E","F#","G#","A","B","C#","D#"],
  F:  ["F","G","A","Bb","C","D","E"],
  Gb: ["Gb","Ab","Bb","Cb","Db","Eb","F"],
  G:  ["G","A","B","C","D","E","F#"],
  Ab: ["Ab","Bb","C","Db","Eb","F","G"]
};

function updateGestureGuide() {
  if (!gestureGuideEl) return;

  const scale = MAJOR_SCALE[currentKeyName];

  gestureGuideEl.innerHTML = GESTURE_GUIDE
    .map(({ degree, gesture }) => `
      <div class="gesture-guide-row">
        <span class="gesture-guide-note">
          ${scale[degree - 1]}
        </span>

        <span class="gesture-guide-gesture">
          ${gesture}
        </span>
      </div>
    `)
    .join("");
}

// ---- Chord -> note frequencies ----
// Semitone offset of each scale degree from the tonic, in a major scale.
// This stays fixed -- what changes is which frequency counts as "0".
const DEGREE_SEMITONES = { 1: 0, 2: 2, 3: 4, 4: 5, 5: 7, 6: 9 ,7: -1};

const keySelectEl = document.getElementById("keySelect");

let currentTonicFreq = Number(keySelectEl.value);

let currentKeyName =
  keySelectEl.selectedOptions[0].dataset.note;

  updateGestureGuide();

  keySelectEl.addEventListener("change", () => {

  currentTonicFreq = Number(keySelectEl.value);

  currentKeyName =
    keySelectEl.selectedOptions[0].dataset.note;

  updateGestureGuide();

});

const toneSelectEl = document.getElementById("toneSelect");
let currentWaveform = toneSelectEl.value;

toneSelectEl.addEventListener("change", () => {
  currentWaveform = toneSelectEl.value;
  synth.currentKey = null; // forces sound refresh
});

function getDegreeFreq(degree) {
  const semitones = DEGREE_SEMITONES[degree];

  let tonic = currentTonicFreq;

  // Drop these keys one octave
  if (
    tonic === 369.99 || // Gb/F#
    tonic === 392.00 || // G
    tonic === 415.30    // Ab/G#
  ) {
    tonic /= 2;
  }

  return tonic * Math.pow(2, semitones / 12);
}

const NUMERAL_TO_DEGREE = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7
};



function getChordName(roman, isMajorMode) {

  if (!roman || roman === "--") {
    return "";
  }

  const degree =
    NUMERAL_TO_DEGREE[roman.toUpperCase()];

  if (!degree) {
    return "";
  }

  const root =
    MAJOR_SCALE[currentKeyName][degree - 1];


  return isMajorMode
    ? root
    : root + "m";

}


// Generate all fundamental raw intervals relative to the degree root
function getChordTones(numeralStr, isMajorMode) {
  if (!numeralStr || numeralStr === "--") return null;

  const degree = NUMERAL_TO_DEGREE[numeralStr.toUpperCase()];
  if (!degree) return null;

  const root = getDegreeFreq(degree); 

  // Define scale intervals using precise semitone adjustments
  const thirdSemitones = isMajorMode ? 4 : 3;
  const fifthSemitones = 7; // Fixed perfect 5th for modes 1, 2, 3

  // Extension semitones (11 for Major 7th, 10 for Dominant 7, 9 for Diminished 7)
  const maj7Semitones = 11;
  const dom7Semitones = 10;
  const dim7Semitones = 9;

  // Build the tone collection
  const third = root * Math.pow(2, thirdSemitones / 12);
  const fifth = root * Math.pow(2, fifthSemitones / 12);
  
  const octaveRoot = root * 2;
  const octaveThird = third * 2;

  // Special extension notes
  const maj7Tone = root * Math.pow(2, maj7Semitones / 12);
  const dom7Tone = root * Math.pow(2, dom7Semitones / 12);
  const dim7Tone = root * Math.pow(2, dim7Semitones / 12);

  // If left hand mode is minor, case 4 needs a diminished 5th (tritone) for the Diminished 7th chord
  const dim5Tone = root * Math.pow(2, 6 / 12);

  return { 
    root, third, fifth, octaveRoot, octaveThird, 
    maj7Tone, dom7Tone, dim7Tone, dim5Tone 
  };
}

// Map the 4 right-hand finger variations depending entirely on the left-hand tilt mode
function getSolidNotes(tones, rightHandCount, isMajorMode) {
  if (!tones) return [];
  
  const { 
    root, third, fifth, octaveRoot, octaveThird, 
    maj7Tone, dom7Tone, dim7Tone, dim5Tone 
  } = tones;

  if (isMajorMode) {
    switch (rightHandCount) {
      case 1: // Major chord (root, fifth, octave, octave third)
        return [root, fifth, octaveRoot, octaveThird];
      case 2: // 1st inversion (third, fifth, octave, octave third)
        return [third, fifth, octaveRoot, octaveThird];
      case 3: // Major 7th (root, third, fifth, maj7)
        return [root, third, fifth, maj7Tone];
      case 4: // Dominant 7th (root, third, fifth, dom7)
        return [root, third, fifth, dom7Tone];
      default: 
        return [root, fifth, octaveRoot, octaveThird];
    }
  } else {
    // Minor Mode Routing
    switch (rightHandCount) {
      case 1: // Minor chord (root, fifth, octave, octave minor third)
        return [root, fifth, octaveRoot, octaveThird];
      case 2: // 1st inversion (minor third, fifth, octave, octave minor third)
        return [third, fifth, octaveRoot, octaveThird];
      case 3: // Minor 7th (root, third, fifth, dom7)
        return [root, third, fifth, dom7Tone]; 
      case 4: // Diminished 7th (root, minor third, diminished fifth, dim7)
        return [root, third, dim5Tone, dim7Tone];
      default: 
        return [root, fifth, octaveRoot, octaveThird];
    }
  }
}

// ---- Synth engine: oscillators -> lowpass filter -> master volume ----
class SynthEngine {
  constructor() {
    this.ctx = null;
    this.filter = null;
    this.waveShaper = null;
    this.masterGain = null;
    this.oscillators = [];
    this.currentKey = null;
  }

  ensureContext() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    this.waveShaper = this.ctx.createWaveShaper();
    this.waveShaper.curve = null;
    this.waveShaper.oversample = "4x"; // Reduces aliasing harshness

    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 1200;
    this.filter.Q.value = 0.7;

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0;

    // Signal chain: oscillators -> waveshaper -> filter -> masterGain -> output
    this.waveShaper.connect(this.filter);
    this.filter.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);
  }

  updateVolume(volume01) {
    if (!this.ctx) return;
    // Smooth gain transitions to prevent audio clicking
    this.masterGain.gain.setTargetAtTime(volume01, this.ctx.currentTime, 0.03);
  }
  setVolume(volume01) {
    if (!this.ctx) return;
    const clamped = Math.max(0, Math.min(1, volume01));
    this.masterGain.gain.linearRampToValueAtTime(clamped, this.ctx.currentTime + 0.05);
  }

  updateFilterSweep(tiltFactor) {
    if (!this.filter || !this.ctx) return;

    // Base parameters for a balanced centered (0%) hand
    let targetFrequency = 1200;
    let targetQ = 0.7;

    if (tiltFactor < 0) {
      // ---- INWARD TILT (Acoustic Warmth) ----
      const intensity = Math.abs(tiltFactor); 
      targetFrequency = 1200 - (intensity * 950);
      targetQ = 0.7 + (intensity * 1.5); // Add a subtle woody, hollow resonance
    } 
    else if (tiltFactor > 0) {
      // ---- OUTWARD TILT (EDM Filter Sweep) ----
      targetFrequency = 1200 + (tiltFactor * 3800);
      targetQ = 0.7 + (tiltFactor * 4.5); // Spikes resonance for synthetic "squelch"
    }

    // Smooth out audio node updates frame-by-frame to eliminate audio clicking
    const now = this.ctx.currentTime;
    this.filter.frequency.setTargetAtTime(targetFrequency, now, 0.04);
    this.filter.Q.setTargetAtTime(targetQ, now, 0.04);
  }

  playNotes(freqs) {
    if (!this.ctx || freqs.length === 0) return;

    if (!hasPlayedFirstSound) {
      hasPlayedFirstSound = true;
      trackClarityEvent("first_sound");
    }

    const key = freqs.map((f) => f.toFixed(1)).join(",");
    if (key === this.currentKey) return;

    this.oscillators.forEach((osc) => { try { osc.stop(); } catch {} });
    this.oscillators = freqs.map((freq) => {
      const osc = this.ctx.createOscillator();
      osc.type = currentWaveform;
      osc.frequency.value = freq;
      osc.connect(this.waveShaper); // was: this.filter
      osc.start();
      return osc;
    });
    this.currentKey = key;
  }

  stop() {
    this.setVolume(0);
    this.oscillators.forEach((osc) => {
      try {
        osc.stop();
        osc.disconnect();
      } catch {}
    });
    this.oscillators = [];
    this.currentKey = null;
  }
}

const synth = new SynthEngine();

const DRUM_STEPS = 8;
const DRUM_TRACKS = [
  { id: "kick", label: "Kick" },
  { id: "snare", label: "Snare" },
  { id: "closedHat", label: "Closed Hat" },
  { id: "openHat", label: "Open Hat" },
  { id: "tom", label: "Tom" },
];
const drumPattern = Object.fromEntries(
  DRUM_TRACKS.map(({ id }) => [id, Array(DRUM_STEPS).fill(false)])
);
let drumMasterGain = null;
let drumNoiseBuffer = null;
let drumScheduler = null;
let drumIsPlaying = false;
let nextDrumStep = 0;
let nextDrumStepTime = 0;

function buildDrumGrid() {
  DRUM_TRACKS.forEach((track) => {
    const row = document.createElement("div");
    row.className = "drum-grid-row";

    const label = document.createElement("span");
    label.className = "drum-track-label";
    label.textContent = track.label;
    row.append(label);

    for (let step = 0; step < DRUM_STEPS; step += 1) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "drum-step";
      cell.dataset.track = track.id;
      cell.dataset.step = String(step);
      cell.setAttribute("aria-label", `${track.label}, step ${step + 1}`);
      cell.setAttribute("aria-pressed", "false");
      row.append(cell);
    }

    drumGrid.append(row);
  });
}

function ensureDrumAudio() {
  const audioContext = synth.ctx;
  if (!audioContext) return false;

  if (!drumMasterGain) {
    drumMasterGain = audioContext.createGain();
    drumMasterGain.gain.value = 0.75;
    drumMasterGain.connect(audioContext.destination);

    drumNoiseBuffer = audioContext.createBuffer(
      1,
      audioContext.sampleRate,
      audioContext.sampleRate
    );
    const noise = drumNoiseBuffer.getChannelData(0);
    for (let index = 0; index < noise.length; index += 1) {
      noise[index] = Math.random() * 2 - 1;
    }
  }

  return true;
}

function playDrumTone(startFrequency, endFrequency, duration, volume, time) {
  const audioContext = synth.ctx;
  const oscillator = audioContext.createOscillator();
  const envelope = audioContext.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(startFrequency, time);
  oscillator.frequency.exponentialRampToValueAtTime(endFrequency, time + duration);
  envelope.gain.setValueAtTime(volume, time);
  envelope.gain.exponentialRampToValueAtTime(0.001, time + duration);
  oscillator.connect(envelope);
  envelope.connect(drumMasterGain);
  oscillator.start(time);
  oscillator.stop(time + duration + 0.01);
}

function playDrumNoise(duration, cutoff, volume, time) {
  const audioContext = synth.ctx;
  const source = audioContext.createBufferSource();
  const filter = audioContext.createBiquadFilter();
  const envelope = audioContext.createGain();

  source.buffer = drumNoiseBuffer;
  filter.type = "highpass";
  filter.frequency.setValueAtTime(cutoff, time);
  envelope.gain.setValueAtTime(volume, time);
  envelope.gain.exponentialRampToValueAtTime(0.001, time + duration);
  source.connect(filter);
  filter.connect(envelope);
  envelope.connect(drumMasterGain);
  source.start(time);
  source.stop(time + duration + 0.01);
}

function playDrumHit(trackId, scheduledTime = synth.ctx.currentTime) {
  const time = Math.max(scheduledTime, synth.ctx.currentTime + 0.005);

  switch (trackId) {
    case "kick":
      playDrumTone(155, 48, 0.22, 0.9, time);
      break;
    case "snare":
      playDrumNoise(0.18, 1400, 0.48, time);
      playDrumTone(190, 125, 0.1, 0.28, time);
      break;
    case "closedHat":
      playDrumNoise(0.045, 7500, 0.3, time);
      break;
    case "openHat":
      playDrumNoise(0.24, 6500, 0.32, time);
      break;
    case "tom":
      playDrumTone(190, 78, 0.24, 0.65, time);
      break;
  }
}

function setDrumPlayhead(step) {
  drumGrid.querySelectorAll(".drum-step").forEach((cell) => {
    cell.classList.toggle("playing-step", Number(cell.dataset.step) === step);
  });
}

function getDrumBpm() {
  const bpm = Number(drumBpmInput.value);
  const normalizedBpm = Math.max(40, Math.min(240, Math.round(bpm || 120)));
  drumBpmInput.value = String(normalizedBpm);
  return normalizedBpm;
}

function scheduleDrumSteps() {
  if (!drumIsPlaying || !synth.ctx) return;

  const audioContext = synth.ctx;
  const scheduleUntil = audioContext.currentTime + 0.12;

  while (nextDrumStepTime < scheduleUntil) {
    setDrumPlayhead(nextDrumStep);
    DRUM_TRACKS.forEach(({ id }) => {
      if (drumPattern[id][nextDrumStep]) {
        playDrumHit(id, nextDrumStepTime);
      }
    });

    nextDrumStep = (nextDrumStep + 1) % DRUM_STEPS;
    nextDrumStepTime += 60 / getDrumBpm() / 2;
  }
}

async function toggleDrumPlayback() {
  if (drumIsPlaying) {
    stopDrumPlayback();
    return;
  }
  if (!ensureDrumAudio()) {
    drumStatus.textContent = "Start Gesture Synth first to enable audio.";
    return;
  }

  if (synth.ctx.state === "suspended") await synth.ctx.resume();
  drumIsPlaying = true;
  nextDrumStep = 0;
  nextDrumStepTime = synth.ctx.currentTime + 0.03;
  playDrumsButton.textContent = "Stop";
  playDrumsButton.setAttribute("aria-pressed", "true");
  drumScheduler = setInterval(scheduleDrumSteps, 25);
  scheduleDrumSteps();
}

function stopDrumPlayback() {
  drumIsPlaying = false;
  if (drumScheduler !== null) {
    clearInterval(drumScheduler);
    drumScheduler = null;
  }
  nextDrumStep = 0;
  playDrumsButton.textContent = "Play";
  playDrumsButton.setAttribute("aria-pressed", "false");
  setDrumPlayhead(-1);
}

buildDrumGrid();

drumButton.addEventListener("click", () => {
  const isOpen = drumPanel.classList.toggle("hidden") === false;
  drumButton.setAttribute("aria-expanded", String(isOpen));
  if (isOpen) {
    lyricsPanel.classList.add("hidden");
    lyricsButton.setAttribute("aria-expanded", "false");
  }
});

closeDrumPanel.addEventListener("click", () => {
  drumPanel.classList.add("hidden");
  drumButton.setAttribute("aria-expanded", "false");
  drumButton.focus();
});

drumGrid.addEventListener("click", (event) => {
  const cell = event.target.closest(".drum-step");
  if (!cell) return;

  const trackId = cell.dataset.track;
  const step = Number(cell.dataset.step);
  const isActive = !drumPattern[trackId][step];
  drumPattern[trackId][step] = isActive;
  cell.setAttribute("aria-pressed", String(isActive));

  if (isActive && !drumIsPlaying && ensureDrumAudio()) {
    playDrumHit(trackId);
  }
});

playDrumsButton.addEventListener("click", toggleDrumPlayback);
drumBpmInput.addEventListener("change", getDrumBpm);

let hasPlayedFirstSound = false;
let lastTrackedChord = null;
let startupInProgress = false;

startOverlayEl.addEventListener("click", async (event) => {
  if (event.target.closest("a") || startupInProgress) return;

  startupInProgress = true;
  startStatusEl.textContent = "Starting camera and hand tracking. Allow camera access when your browser asks.";
  try {
    synth.ensureContext();
    await main();
    startOverlayEl.style.display = "none";
    canvasEl.classList.remove("dimmed");
  } catch (error) {
    console.error("Gesture Synth startup failed:", error);
    if (error.name === "NotAllowedError") {
      startStatusEl.textContent = "Camera access was blocked. Allow camera access for this site in your browser settings, then click here to retry.";
    } else if (error.name === "NotFoundError") {
      startStatusEl.textContent = "No camera was found. Connect a camera and click here to retry.";
    } else if (error.name === "NotReadableError") {
      startStatusEl.textContent = "The camera is in use by another app. Close it and click here to retry.";
    } else if (error.message === "camera-insecure-context") {
      startStatusEl.textContent = "Camera access requires HTTPS (or localhost). Open the secure test-site URL and try again.";
    } else if (error.message === "camera-unavailable") {
      startStatusEl.textContent = "Camera access is unavailable in this browser. Try a current browser over HTTPS.";
    } else {
      startStatusEl.textContent = "Startup failed. Check camera permissions and your connection, then click here to retry.";
    }
    startupInProgress = false;
  }
});

guideToggleEl.addEventListener("click", () => {
  const isHidden = gestureGuideEl.classList.toggle("hidden");

  if (!isHidden) {
    trackClarityEvent("guide_opened");
  }

  guideToggleEl.textContent = isHidden ? "Open Guide" : "Close Guide";
});

helpButton.addEventListener("click", () => {
  trackClarityEvent("help_opened");
  helpModal.classList.remove("hidden");
});

closeHelp.addEventListener("click", (e) => {
  e.stopPropagation();
  helpModal.classList.add("hidden");
});

// Optional: click outside the card to close
helpModal.addEventListener("click", (e) => {
  if (e.target === helpModal) {
    helpModal.classList.add("hidden");
  }
});

lyricsButton.addEventListener("click", () => {
  const isOpen = lyricsPanel.classList.toggle("hidden") === false;
  lyricsButton.setAttribute("aria-expanded", String(isOpen));
  if (isOpen) {
    drumPanel.classList.add("hidden");
    drumButton.setAttribute("aria-expanded", "false");
    lyricsQuery.focus();
  }
});

closeLyrics.addEventListener("click", () => {
  lyricsPanel.classList.add("hidden");
  lyricsButton.setAttribute("aria-expanded", "false");
  lyricsButton.focus();
});

let lyricEntries = [];
let nextLyricIndex = 0;
let elapsedBeforePause = 0;
let playbackStartedAt = 0;
let playbackTimer = null;

function showLyricWindow(currentIndex, behavior = "smooth") {
  const rows = karaokeLines.children;
  Array.from(rows).forEach((row) => row.classList.remove("current", "next"));

  const currentRow = rows[currentIndex];
  if (!currentRow) return;
  currentRow.classList.add("current");

  const nextRow = rows[currentIndex + 1];
  if (nextRow) nextRow.classList.add("next");

  karaokeLines.scrollTo({
    top: currentRow.offsetTop - karaokeLines.offsetTop,
    behavior,
  });
}

function pauseLyrics() {
  if (playbackTimer === null) return;
  clearTimeout(playbackTimer);
  playbackTimer = null;
  elapsedBeforePause += (performance.now() - playbackStartedAt) / 1000;
  karaokeToggle.textContent = "Play";
}

function revealNextLyrics() {
  const elapsed = elapsedBeforePause + (performance.now() - playbackStartedAt) / 1000;

  while (nextLyricIndex < lyricEntries.length && lyricEntries[nextLyricIndex].time <= elapsed) {
    showLyricWindow(nextLyricIndex);
    nextLyricIndex += 1;
  }

  if (nextLyricIndex >= lyricEntries.length) {
    playbackTimer = null;
    karaokeToggle.textContent = "Play";
    return;
  }

  const delay = (lyricEntries[nextLyricIndex].time - elapsed) * 1000;
  playbackTimer = setTimeout(revealNextLyrics, Math.max(40, delay));
}

function toggleLyricsPlayback() {
  if (playbackTimer !== null) {
    pauseLyrics();
    return;
  }

  if (lyricEntries.length === 0) return;
  if (nextLyricIndex >= lyricEntries.length) {
    nextLyricIndex = 0;
    elapsedBeforePause = 0;
    showLyricWindow(0, "instant");
  }

  playbackStartedAt = performance.now();
  karaokeToggle.textContent = "Pause";
  revealNextLyrics();
}

karaokeToggle.addEventListener("click", toggleLyricsPlayback);

closeKaraoke.addEventListener("click", () => {
  pauseLyrics();
  karaokeOverlay.classList.add("hidden");
});

function getLyricEntries(result) {
  const syncedLyrics = result.syncedLyrics || "";
  const timestampPattern = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;
  const timedEntries = [];

  syncedLyrics.split(/\r?\n/).forEach((line) => {
    const timestamps = [...line.matchAll(timestampPattern)];
    const text = line.replace(timestampPattern, "").trim();
    if (!text || timestamps.length === 0) return;

    timestamps.forEach((match) => {
      const fraction = match[3] || "0";
      const fractionSeconds = Number(fraction) / (10 ** fraction.length);
      timedEntries.push({
        text,
        time: Number(match[1]) * 60 + Number(match[2]) + fractionSeconds,
      });
    });
  });

  if (timedEntries.length > 0) {
    timedEntries.sort((left, right) => left.time - right.time);
    const firstTimestamp = timedEntries[0].time;
    return timedEntries.map((entry) => ({ ...entry, time: entry.time - firstTimestamp }));
  }

  return (result.plainLyrics || syncedLyrics)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text, index) => ({ text, time: index * 3.5 }));
}

function renderLyricsResult(result, selectedButton) {
  lyricsResults.querySelectorAll(".lyrics-result").forEach((button) => {
    button.setAttribute("aria-pressed", String(button === selectedButton));
  });

  lyricEntries = getLyricEntries(result);
  if (lyricEntries.length === 0) {
    lyricsStatus.textContent = "This result does not include readable lyrics.";
    return;
  }

  pauseLyrics();
  nextLyricIndex = 0;
  elapsedBeforePause = 0;
  karaokeLines.replaceChildren();
  lyricEntries.forEach(({ text }) => {
    const row = document.createElement("li");
    row.textContent = text;
    karaokeLines.append(row);
  });
  showLyricWindow(0, "instant");
  karaokeToggle.textContent = "Play";
  karaokeOverlay.classList.remove("hidden");
  lyricsPanel.classList.add("hidden");
  lyricsButton.setAttribute("aria-expanded", "false");
}

lyricsSearchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = lyricsQuery.value.trim();
  if (!query) return;

  lyricsStatus.textContent = "Searching LRCLIB...";
  lyricsResults.replaceChildren();

  try {
    const response = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`LRCLIB returned ${response.status}`);

    const results = await response.json();
    if (!Array.isArray(results) || results.length === 0) {
      lyricsStatus.textContent = "No matches found. Try a different song or artist.";
      return;
    }

    const availableResults = results.filter((result) => result.plainLyrics || result.syncedLyrics);
    if (availableResults.length === 0) {
      lyricsStatus.textContent = "Matches found, but none include readable lyrics.";
      return;
    }

    lyricsStatus.textContent = `${availableResults.length} result${availableResults.length === 1 ? "" : "s"}. Select one to read.`;
    availableResults.slice(0, 20).forEach((result) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "lyrics-result";
      button.setAttribute("aria-pressed", "false");
      button.textContent = `${result.trackName || result.name || "Untitled track"} - ${result.artistName || "Unknown artist"}`;
      button.addEventListener("click", () => renderLyricsResult(result, button));
      lyricsResults.append(button);
    });
  } catch (error) {
    console.error("Lyrics search failed:", error);
    lyricsStatus.textContent = "Lyrics could not be loaded. Check your connection and try again.";
  }
});

// Computes a "cover" crop rect in source-video pixel space: the largest
// centered rectangle matching the destination's aspect ratio, so the
// video fills the screen (height fit, width cropped) with zero stretch.
function computeCoverRect(srcW, srcH, dstW, dstH) {
  const srcRatio = srcW / srcH;
  const dstRatio = dstW / dstH;

  if (srcRatio > dstRatio) {
    const sHeight = srcH;
    const sWidth = srcH * dstRatio;
    return { sx: (srcW - sWidth) / 2, sy: 0, sWidth, sHeight };
  } else {
    const sWidth = srcW;
    const sHeight = srcW / dstRatio;
    return { sx: 0, sy: (srcH - sHeight) / 2, sWidth, sHeight };
  }
}

function drawFrame(results, canvasWidth, canvasHeight) {
  const srcW = videoEl.videoWidth;
  const srcH = videoEl.videoHeight;
  if (!srcW || !srcH) return;

  const { sx, sy, sWidth, sHeight } = computeCoverRect(srcW, srcH, canvasWidth, canvasHeight);

  ctx.save();
  ctx.clearRect(0, 0, canvasWidth, canvasHeight);
  ctx.translate(canvasWidth, 0);
  ctx.scale(-1, 1);

  ctx.drawImage(videoEl, sx, sy, sWidth, sHeight, 0, 0, canvasWidth, canvasHeight);

  ctx.fillStyle = "#ffffff80";
  for (const landmarks of results.landmarks) {
    for (const point of landmarks) {
      const videoPx = point.x * srcW;
      const videoPy = point.y * srcH;
      const canvasX = ((videoPx - sx) / sWidth) * canvasWidth;
      const canvasY = ((videoPy - sy) / sHeight) * canvasHeight;

      ctx.beginPath();
      ctx.arc(canvasX, canvasY, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// ---- Main loop ----
function resizeCanvas() {
  canvasEl.width = window.innerWidth;
  canvasEl.height = window.innerHeight;
}

async function main() {
  await setupCamera();
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  const handLandmarker = await setupHandLandmarker();

  let lastVideoTime = -1;
  
  // Persistent structural cache to keep landmark data accessible across high-speed ticks
  let cachedLeftLandmarks = null;
  let cachedRightLandmarks = null;

  function loop() {
  const timestampNow = performance.now();

  // ============================
  // 1. UPDATE MEDIAPIPE FRAME
  // ============================

  if (videoEl.currentTime !== lastVideoTime) {
    lastVideoTime = videoEl.currentTime;

    const results = handLandmarker.detectForVideo(videoEl, timestampNow);

    drawFrame(
      results,
      canvasEl.width,
      canvasEl.height
    );

    cachedLeftLandmarks = null;
    cachedRightLandmarks = null;

    results.landmarks.forEach((landmarks, i) => {
      const handedness = results.handedness[i][0].categoryName;

      if (handedness === "Left") {
        cachedLeftLandmarks = landmarks;
      }

      if (handedness === "Right") {
        cachedRightLandmarks = landmarks;
      }
    });
  }


  // ============================
  // 2. RAW GESTURE STATES
  // ============================

  let currentChord = null;
  let isMajorMode = true;

  let qualityIndex = 0;
  let thumbDown = false;


  let rawChordState = null;


  // ============================
// BUILD MUSICAL CHORD STATE
// ============================

let rawChord = null;
let rawMode = true;
let rawQualityIndex = 0;
let rawThumbDown = false;


// LEFT HAND = ROOT CHORD

if (cachedLeftLandmarks) {

  const leftTilt =
    getHandHorizontalTilt(
      cachedLeftLandmarks,
      "Left"
    );


  rawChord =
    classifyChord(
      cachedLeftLandmarks,
      "Left"
    );


  rawMode =
    leftTilt >= 0;

}


// RIGHT HAND = VOICING

if (cachedRightLandmarks) {

  rawQualityIndex =
    getRightHandQualityIndex(
      cachedRightLandmarks
    );


  rawThumbDown =
    isThumbExtended(
      cachedRightLandmarks,
      "Right"
    );

}


// Combine into ONE musical object

if (rawChord) {

  rawChordState = {

    chord: rawChord,

    isMajorMode: rawMode,

    qualityIndex: rawQualityIndex,

    thumbDown: rawThumbDown

  };

}


  // ============================
  // 3. STABILIZE HANDS
  // ============================

  const stableChordState =
  stabilizeChordState(
    rawChordState,
    timestampNow
  );


  if (stableChordState) {

  currentChord =
    stableChordState.chord;


  isMajorMode =
    stableChordState.isMajorMode;


  qualityIndex =
    stableChordState.qualityIndex;


  thumbDown =
    stableChordState.thumbDown;

}


  // ============================
  // 4. UI UPDATE
  // ============================

  if (currentChord) {
  const chordName =
    getChordName(
      currentChord,
      isMajorMode
    );

  chordDisplayEl.textContent =
    `${chordName}(${currentChord})`;
  } else {
    chordDisplayEl.textContent = "--";
  }


  const MAJOR_LABELS = {
    1: "Major",
    2: "Major 1st Inv",
    3: "Major 7th",
    4: "Dominant 7th"
  };


  const MINOR_LABELS = {
    1: "Minor",
    2: "Minor 1st Inv",
    3: "Minor 7th",
    4: "Diminished 7th"
  };


  const activeLabel =
    isMajorMode
      ? MAJOR_LABELS[qualityIndex]
      : MINOR_LABELS[qualityIndex];


  qualityDisplayEl.textContent =
    activeLabel
      ? `${activeLabel}${thumbDown ? " (-8ve)" : ""}`
      : "--";



  // ============================
  // 5. AUDIO ENGINE
  // ============================

  if (cachedRightLandmarks) {

    const currentVolume =
      getVolumeFromHeight(
        cachedRightLandmarks
      );


    updateVolumeMeter(currentVolume);


    const horizontalTilt =
      getHandHorizontalTilt(
        cachedRightLandmarks,
        "Right"
      );


    const tiltPercentage =
      Math.round(horizontalTilt * 100);


    const targetEl =
      document.getElementById(
        "distortionDisplay"
      );


    if (targetEl) {

      targetEl.textContent =
        `Filter: ${tiltPercentage > 0 ? "+" : ""}${tiltPercentage}%`;

    }


    synth.updateFilterSweep(
      horizontalTilt
    );


    if (
      currentChord &&
      qualityIndex >= 1
    ) {

      const chordTrackingKey =
        `${currentChord}-${isMajorMode ? "major" : "minor"}-${qualityIndex}-${thumbDown ? "low" : "normal"}`;

      if (chordTrackingKey !== lastTrackedChord) {
        lastTrackedChord = chordTrackingKey;
        trackClarityEvent("chord_changed");
      }

      const tones =
        getChordTones(
          currentChord,
          isMajorMode
        );


      let notes =
        getSolidNotes(
          tones,
          qualityIndex,
          isMajorMode
        );


      if (thumbDown) {
        notes =
          notes.map(
            freq => freq / 2
          );
      }


      synth.playNotes(notes);
      synth.setVolume(
        currentVolume
      );


    } else {

      synth.setVolume(0);

    }


  } else {

    synth.setVolume(0);

  }



  requestAnimationFrame(loop);
}
  
  loop();
}


