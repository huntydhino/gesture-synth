const pedalsButton = document.getElementById("pedalsButton");
const pedalsView = document.getElementById("pedalsView");
const pedalsClose = document.getElementById("pedalsClose");
const inputSelect = document.getElementById("pedalsInput");
const startButton = document.getElementById("pedalsStart");
const statusEl = document.getElementById("pedalsStatus");
const inputCanvas = document.getElementById("pedalsInputScope");
const outputCanvas = document.getElementById("pedalsOutputScope");
const inputLevel = document.getElementById("pedalsInputLevel");
const outputLevel = document.getElementById("pedalsOutputLevel");
const inputReadout = document.getElementById("pedalsInputReadout");
const outputReadout = document.getElementById("pedalsOutputReadout");
const clipFileInput = document.getElementById("pedalsClipFile");
const clipLoopButton = document.getElementById("pedalsClipLoop");
const clipStatus = document.getElementById("pedalsClipStatus");
const presetFileInput = document.getElementById("pedalsPresetFile");
const savePresetButton = document.getElementById("pedalsSavePreset");
const irFileInput = document.getElementById("pedalsIrFile");
const irTargetSelect = document.getElementById("pedalsIrTarget");
const importStatus = document.getElementById("pedalsImportStatus");
const pitchNote = document.getElementById("pedalsPitchNote");
const pitchStatus = document.getElementById("pedalsPitchStatus");
const PITCH_DECIMATION = 6;

let audioContext = null;
let inputStream = null;
let inputSource = null;
let clipSource = null;
let clipBuffer = null;
let importedClipFile = null;
let inputGain = null;
let inputAnalyser = null;
let pitchAnalyser = null;
let outputAnalyser = null;
let masterGain = null;
let compressor = null;
let limiter = null;
let drive = null;
let driveTone = null;
let bitcrusher = null;
let gateGain = null;
let lowEq = null;
let midEq = null;
let highEq = null;
let chorusDelay = null;
let chorusDepth = null;
let chorusLfo = null;
let delayNode = null;
let delayFeedback = null;
let reverbConvolver = null;
let phaserFilters = [];
let phaserLfo = null;
let phaserDepth = null;
let octaveOscillator = null;
let octaveGain = null;
let cabLow = null;
let cabHigh = null;
let cabinetConvolver = null;
let animationFrame = null;
let lastPitchCheck = 0;
let lastInputRms = 0;
let lastDetectedFrequency = null;
let pitchSamples = null;
let pitchBuffer = null;
let normalizedDifference = null;
let gateIsOpen = true;
let reverbUpdateTimer = null;
let importedImpulseFile = null;
let cabinetImpulseBuffer = null;
let reverbImpulseBuffer = null;
const effectBlocks = new Map();

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.dataset.state = isError ? "error" : "ready";
}

function setClipStatus(message, isError = false) {
  clipStatus.textContent = message;
  clipStatus.dataset.state = isError ? "error" : "ready";
}

function setImportStatus(message, isError = false) {
  importStatus.textContent = message;
  importStatus.dataset.state = isError ? "error" : "ready";
}

async function refreshInputDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const selectedId = inputSelect.value;
  const inputs = devices.filter((device) => device.kind === "audioinput");

  inputSelect.replaceChildren(new Option("Default audio input", ""));
  inputs.forEach((device, index) => {
    inputSelect.add(new Option(device.label || `Audio input ${index + 1}`, device.deviceId));
  });

  if (inputs.some((device) => device.deviceId === selectedId)) {
    inputSelect.value = selectedId;
  }
}

function connectEffect(name, nodes, enabled = true, mix = 1) {
  const input = audioContext.createGain();
  const dry = audioContext.createGain();
  const wet = audioContext.createGain();
  const output = audioContext.createGain();

  input.connect(dry);
  dry.connect(output);
  let previous = input;
  nodes.forEach((node) => {
    previous.connect(node);
    previous = node;
  });
  previous.connect(wet);
  wet.connect(output);

  const block = { dry, wet, enabled, mix };
  effectBlocks.set(name, block);
  setEffectEnabled(name, enabled);
  return { input, output };
}

function setEffectEnabled(name, enabled) {
  const block = effectBlocks.get(name);
  const section = document.querySelector(`[data-effect="${name}"]`);
  const toggle = section?.querySelector(`[data-toggle="${name}"]`);
  if (section) section.dataset.bypassed = String(!enabled);
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(enabled));
    toggle.textContent = enabled ? "ON" : "BYPASS";
  }
  if (!block) return;
  block.enabled = enabled;
  if (name === "octaver") {
    updateOctaveOutputGain();
    return;
  }
  const now = audioContext.currentTime;
  const dryLevel = enabled ? 1 - block.mix : 1;
  const wetLevel = enabled ? block.mix : 0;
  block.dry.gain.setTargetAtTime(dryLevel, now, 0.015);
  block.wet.gain.setTargetAtTime(wetLevel, now, 0.015);
}

function getControlValue(parameter) {
  return Number(document.querySelector(`[data-param="${parameter}"]`).value);
}

function createDriveCurve(amount) {
  const samples = 2048;
  const curve = new Float32Array(samples);
  const driveAmount = 1 + amount * 20;
  const normalization = Math.tanh(driveAmount);
  for (let index = 0; index < samples; index += 1) {
    const x = (index * 2) / (samples - 1) - 1;
    curve[index] = Math.tanh(driveAmount * x) / normalization;
  }
  return curve;
}

function createBitcrusherCurve(bits) {
  const steps = 2 ** bits;
  const curve = new Float32Array(4096);
  for (let index = 0; index < curve.length; index += 1) {
    const sample = (index * 2) / (curve.length - 1) - 1;
    curve[index] = Math.round(sample * steps) / steps;
  }
  return curve;
}

function createReverbImpulse(duration) {
  const frames = Math.max(1, Math.round(audioContext.sampleRate * duration));
  const impulse = audioContext.createBuffer(2, frames, audioContext.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let frame = 0; frame < frames; frame += 1) {
      const decay = (1 - frame / frames) ** 2.4;
      data[frame] = (Math.random() * 2 - 1) * decay;
    }
  }
  return impulse;
}

function updateOctaveOutputGain() {
  if (!audioContext || !octaveGain) return;
  const enabled = effectBlocks.get("octaver")?.enabled;
  const level = getControlValue("octaveLevel") / 100;
  const amplitude = enabled && lastDetectedFrequency
    ? Math.min(0.3, level * 0.35) * Math.min(1, lastInputRms * 12)
    : 0;
  octaveGain.gain.setTargetAtTime(amplitude, audioContext.currentTime, 0.03);
}

function updatePitchEstimate() {
  if (!audioContext || !pitchAnalyser || !pitchSamples) return;
  pitchAnalyser.getFloatTimeDomainData(pitchSamples);

  const stride = PITCH_DECIMATION;
  let sampleCount = 0;
  let squaredSum = 0;
  for (let index = 0; index < pitchBuffer.length * stride; index += stride) {
    const end = index + stride;
    let value = 0;
    for (let sample = index; sample < end; sample += 1) value += pitchSamples[sample];
    value /= end - index;
    pitchBuffer[sampleCount] = value;
    squaredSum += value * value;
    sampleCount += 1;
  }

  lastInputRms = Math.sqrt(squaredSum / sampleCount);
  const gateBlock = effectBlocks.get("gate");
  if (gateBlock?.enabled && gateGain) {
    const threshold = 10 ** (getControlValue("gateThreshold") / 20);
    if (gateIsOpen && lastInputRms < threshold * 0.75) gateIsOpen = false;
    else if (!gateIsOpen && lastInputRms > threshold * 1.25) gateIsOpen = true;
    gateGain.gain.setTargetAtTime(gateIsOpen ? 1 : 0, audioContext.currentTime, gateIsOpen ? 0.008 : 0.08);
  }

  if (lastInputRms < 0.003) {
    lastDetectedFrequency = null;
    pitchNote.textContent = "--";
    pitchStatus.textContent = "Listening for a clear bass note.";
    updateOctaveOutputGain();
    return;
  }

  const effectiveSampleRate = audioContext.sampleRate / stride;
  const minLag = Math.max(2, Math.floor(effectiveSampleRate / 1000));
  const maxLag = Math.min(Math.floor(effectiveSampleRate / 28), sampleCount / 2 - 1);
  let cumulativeDifference = 0;
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let difference = 0;
    for (let index = 0; index < sampleCount - lag; index += 1) {
      const delta = pitchBuffer[index] - pitchBuffer[index + lag];
      difference += delta * delta;
    }
    cumulativeDifference += difference;
    normalizedDifference[lag] = cumulativeDifference > 0
      ? difference * lag / cumulativeDifference
      : 1;
  }

  let selectedLag = 0;
  for (let lag = minLag; lag < maxLag; lag += 1) {
    if (normalizedDifference[lag] < 0.16) {
      while (lag + 1 < maxLag && normalizedDifference[lag + 1] < normalizedDifference[lag]) {
        lag += 1;
      }
      selectedLag = lag;
      break;
    }
  }
  if (!selectedLag) {
    for (let lag = minLag; lag < maxLag; lag += 1) {
      if (!selectedLag || normalizedDifference[lag] < normalizedDifference[selectedLag]) selectedLag = lag;
    }
    if (!selectedLag || normalizedDifference[selectedLag] > 0.28) selectedLag = 0;
  }

  if (!selectedLag) {
    lastDetectedFrequency = null;
    pitchNote.textContent = "--";
    pitchStatus.textContent = "Unclear pitch · try a single sustained bass note.";
    updateOctaveOutputGain();
    return;
  }

  const previous = normalizedDifference[selectedLag - 1] ?? normalizedDifference[selectedLag];
  const current = normalizedDifference[selectedLag];
  const next = normalizedDifference[selectedLag + 1] ?? current;
  const curvature = 2 * current - previous - next;
  const correction = curvature ? 0.5 * (previous - next) / curvature : 0;
  const frequency = effectiveSampleRate / (selectedLag + correction);
  if (!Number.isFinite(frequency) || frequency < 28 || frequency > 1000) {
    lastDetectedFrequency = null;
    pitchNote.textContent = "--";
    pitchStatus.textContent = "Unclear pitch · try a single sustained bass note.";
    updateOctaveOutputGain();
    return;
  }

  lastDetectedFrequency = frequency;
  const midiNote = Math.round(69 + 12 * Math.log2(frequency / 440));
  const noteNames = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const noteName = `${noteNames[(midiNote + 1200) % 12]}${Math.floor(midiNote / 12) - 1}`;
  const cents = Math.round((69 + 12 * Math.log2(frequency / 440) - midiNote) * 100);
  pitchNote.textContent = noteName;
  pitchStatus.textContent = `${frequency.toFixed(1)} Hz · ${cents > 0 ? "+" : ""}${cents} cents · approximate`;
  if (octaveOscillator) {
    octaveOscillator.frequency.setTargetAtTime(
      Math.max(20, Math.min(500, frequency / 2)),
      audioContext.currentTime,
      0.025
    );
  }
  updateOctaveOutputGain();
}

function createAudioGraph() {
  inputGain = audioContext.createGain();
  inputAnalyser = audioContext.createAnalyser();
  inputAnalyser.fftSize = 1024;
  pitchAnalyser = audioContext.createAnalyser();
  pitchAnalyser.fftSize = 8192;
  pitchSamples = new Float32Array(pitchAnalyser.fftSize);
  pitchBuffer = new Float32Array(Math.floor(pitchSamples.length / PITCH_DECIMATION));
  normalizedDifference = new Float32Array(pitchBuffer.length);
  outputAnalyser = audioContext.createAnalyser();
  outputAnalyser.fftSize = 1024;
  masterGain = audioContext.createGain();
  inputGain.gain.value = 10 ** (getControlValue("preamp") / 20);
  masterGain.gain.value = getControlValue("master") / 100;

  gateGain = audioContext.createGain();
  gateGain.gain.value = 1;
  compressor = audioContext.createDynamicsCompressor();
  compressor.knee.value = 12;
  compressor.threshold.value = getControlValue("threshold");
  compressor.ratio.value = getControlValue("ratio");
  compressor.attack.value = getControlValue("attack") / 1000;
  compressor.release.value = getControlValue("release") / 1000;

  drive = audioContext.createWaveShaper();
  drive.oversample = "4x";
  drive.curve = createDriveCurve(getControlValue("drive") / 100);
  driveTone = audioContext.createBiquadFilter();
  driveTone.type = "lowpass";
  driveTone.frequency.value = getControlValue("driveTone");

  bitcrusher = audioContext.createWaveShaper();
  bitcrusher.curve = createBitcrusherCurve(getControlValue("bitDepth"));
  bitcrusher.oversample = "none";

  lowEq = audioContext.createBiquadFilter();
  lowEq.type = "lowshelf";
  lowEq.frequency.value = 100;
  lowEq.gain.value = getControlValue("low");
  midEq = audioContext.createBiquadFilter();
  midEq.type = "peaking";
  midEq.frequency.value = 800;
  midEq.Q.value = 0.8;
  midEq.gain.value = getControlValue("mid");
  highEq = audioContext.createBiquadFilter();
  highEq.type = "highshelf";
  highEq.frequency.value = 4000;
  highEq.gain.value = getControlValue("high");

  chorusDelay = audioContext.createDelay(0.1);
  chorusDelay.delayTime.value = 0.02;
  chorusDepth = audioContext.createGain();
  chorusDepth.gain.value = getControlValue("chorusDepth") / 1000;
  chorusLfo = audioContext.createOscillator();
  chorusLfo.frequency.value = getControlValue("chorusRate");
  chorusLfo.connect(chorusDepth);
  chorusDepth.connect(chorusDelay.delayTime);
  chorusLfo.start();

  delayNode = audioContext.createDelay(2);
  delayNode.delayTime.value = getControlValue("delayTime") / 1000;
  const delayFeedbackFilter = audioContext.createBiquadFilter();
  delayFeedbackFilter.type = "lowpass";
  delayFeedbackFilter.frequency.value = 5000;
  delayFeedback = audioContext.createGain();
  delayFeedback.gain.value = getControlValue("delayFeedback") / 100;
  delayNode.connect(delayFeedbackFilter);
  delayFeedbackFilter.connect(delayFeedback);
  delayFeedback.connect(delayNode);

  reverbConvolver = audioContext.createConvolver();
  reverbConvolver.buffer = reverbImpulseBuffer || createReverbImpulse(getControlValue("reverbDecay"));

  phaserFilters = [800, 1200, 2000, 3200].map((frequency) => {
    const filter = audioContext.createBiquadFilter();
    filter.type = "allpass";
    filter.frequency.value = frequency;
    filter.Q.value = 0.75;
    return filter;
  });
  phaserDepth = audioContext.createGain();
  phaserDepth.gain.value = getControlValue("phaserDepth");
  phaserLfo = audioContext.createOscillator();
  phaserLfo.frequency.value = getControlValue("phaserRate");
  phaserLfo.connect(phaserDepth);
  phaserFilters.forEach((filter) => phaserDepth.connect(filter.frequency));
  phaserLfo.start();

  octaveOscillator = audioContext.createOscillator();
  octaveOscillator.type = "sine";
  octaveOscillator.frequency.value = 55;
  octaveGain = audioContext.createGain();
  octaveGain.gain.value = 0;
  octaveOscillator.connect(octaveGain);
  octaveOscillator.start();

  cabLow = audioContext.createBiquadFilter();
  cabLow.type = "highpass";
  cabLow.frequency.value = getControlValue("cabLow");
  cabLow.Q.value = 0.707;
  cabHigh = audioContext.createBiquadFilter();
  cabHigh.type = "lowpass";
  cabHigh.frequency.value = getControlValue("cabHigh");
  cabHigh.Q.value = 0.707;
  cabinetConvolver = audioContext.createConvolver();
  cabinetConvolver.buffer = cabinetImpulseBuffer;

  limiter = audioContext.createDynamicsCompressor();
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.12;
  limiter.threshold.value = getControlValue("limiterThreshold");

  inputGain.connect(inputAnalyser);
  inputGain.connect(pitchAnalyser);
  let previous = inputAnalyser;
  const chain = [
    ["gate", [gateGain], 1],
    ["compressor", [compressor], 1],
    ["drive", [drive, driveTone], 1],
    ["bitcrusher", [bitcrusher], 1],
    ["eq", [lowEq, midEq, highEq], 1],
    ["chorus", [chorusDelay], 0.35],
    ["phaser", phaserFilters, 1],
    ["delay", [delayNode], getControlValue("delayMix") / 100],
    ["reverb", [reverbConvolver], getControlValue("reverbMix") / 100],
    ["cab", [cabLow, cabHigh], 1],
    ["cabIR", [cabinetConvolver], 1],
  ];

  chain.forEach(([name, nodes, mix]) => {
    const enabled = document.querySelector(`[data-toggle="${name}"]`).getAttribute("aria-pressed") === "true";
    const block = connectEffect(name, nodes, enabled, mix);
    previous.connect(block.input);
    if (name === "gate") octaveGain.connect(block.input);
    previous = block.output;
  });

  previous.connect(masterGain);
  const limiterEnabled = document.querySelector('[data-toggle="limiter"]').getAttribute("aria-pressed") === "true";
  const limiterBlock = connectEffect("limiter", [limiter], limiterEnabled, 1);
  masterGain.connect(limiterBlock.input);
  limiterBlock.output.connect(outputAnalyser);
  outputAnalyser.connect(audioContext.destination);

  const octaverEnabled = document.querySelector('[data-toggle="octaver"]').getAttribute("aria-pressed") === "true";
  effectBlocks.set("octaver", { enabled: octaverEnabled, mix: 0 });
  setEffectEnabled("octaver", octaverEnabled);
}

function connectInputStream(stream) {
  inputStream?.getTracks().forEach((track) => track.stop());
  inputSource?.disconnect();
  inputStream = stream;
  inputSource = audioContext.createMediaStreamSource(stream);
  if (!clipSource) inputSource.connect(inputGain);
}

async function decodeImportedClip() {
  if (!audioContext || !importedClipFile) return;
  const data = await importedClipFile.arrayBuffer();
  clipBuffer = await audioContext.decodeAudioData(data);
  clipLoopButton.disabled = false;
  setClipStatus(`Loaded ${importedClipFile.name}. Use Loop clip to audition it through the rack.`);
}

function stopClipLoop() {
  if (!clipSource) return;
  const source = clipSource;
  clipSource = null;
  source.onended = null;
  try {
    source.stop();
  } catch (error) {
    console.error("Could not stop the PedalsFX clip loop:", error);
  }
  source.disconnect();
  if (inputSource && inputGain) inputSource.connect(inputGain);
  clipLoopButton.setAttribute("aria-pressed", "false");
  clipLoopButton.textContent = "Loop clip";
}

function startClipLoop() {
  if (!audioContext || !clipBuffer || audioContext.state !== "running") {
    setClipStatus("Start the audio engine and import an audio clip before looping.", true);
    return;
  }
  inputSource?.disconnect();
  const source = audioContext.createBufferSource();
  source.buffer = clipBuffer;
  source.loop = true;
  source.connect(inputGain);
  source.start();
  clipSource = source;
  clipLoopButton.setAttribute("aria-pressed", "true");
  clipLoopButton.textContent = "Stop clip";
  setClipStatus(`Looping ${importedClipFile?.name || "imported clip"} through the effects rack.`);
}

async function requestInput() {
  const selectedDevice = inputSelect.value;
  const audio = {
    echoCancellation: false,
    autoGainControl: false,
    noiseSuppression: false,
  };
  if (selectedDevice) audio.deviceId = { exact: selectedDevice };

  const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  connectInputStream(stream);
  await refreshInputDevices();
}

function formatDb(level) {
  if (level < 0.0001) return "−∞ dBFS";
  return `${(20 * Math.log10(level)).toFixed(1)} dBFS`;
}

function drawScope(canvas, analyser, meter, readout, color) {
  if (!analyser) return;
  const pixelRatio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
  const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const context = canvas.getContext("2d");
  const samples = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(samples);
  let peak = 0;
  samples.forEach((sample) => {
    peak = Math.max(peak, Math.abs((sample - 128) / 128));
  });

  context.clearRect(0, 0, width, height);
  context.strokeStyle = "#005c69";
  context.lineWidth = pixelRatio;
  context.beginPath();
  context.moveTo(0, height / 2);
  context.lineTo(width, height / 2);
  context.stroke();
  context.strokeStyle = color;
  context.lineWidth = 1.5 * pixelRatio;
  context.beginPath();
  samples.forEach((sample, index) => {
    const x = (index / (samples.length - 1)) * width;
    const y = (sample / 255) * height;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  context.stroke();

  meter.style.width = `${Math.min(100, peak * 100)}%`;
  meter.classList.toggle("clipping", peak >= 0.98);
  readout.textContent = formatDb(peak);
}

function drawMeters(timestamp = 0) {
  if (!audioContext || audioContext.state !== "running") return;
  drawScope(inputCanvas, inputAnalyser, inputLevel, inputReadout, "#00a8b5");
  drawScope(outputCanvas, outputAnalyser, outputLevel, outputReadout, "#d24683");
  if (timestamp - lastPitchCheck >= 120) {
    lastPitchCheck = timestamp;
    updatePitchEstimate();
  }
  animationFrame = requestAnimationFrame(drawMeters);
}

function setEffectMix(name, value) {
  const block = effectBlocks.get(name);
  if (!block) return;
  block.mix = value / 100;
  setEffectEnabled(name, block.enabled);
}

function updateParameter(parameter, value) {
  if (!audioContext) return;
  const now = audioContext.currentTime;
  const smooth = (audioParam, nextValue) => audioParam.setTargetAtTime(nextValue, now, 0.02);

  switch (parameter) {
    case "preamp":
      smooth(inputGain.gain, 10 ** (value / 20));
      break;
    case "threshold":
      smooth(compressor.threshold, value);
      break;
    case "ratio":
      smooth(compressor.ratio, value);
      break;
    case "attack":
      smooth(compressor.attack, value / 1000);
      break;
    case "release":
      smooth(compressor.release, value / 1000);
      break;
    case "gateThreshold":
      break;
    case "drive":
      drive.curve = createDriveCurve(value / 100);
      break;
    case "driveTone":
      smooth(driveTone.frequency, value);
      break;
    case "low":
      smooth(lowEq.gain, value);
      break;
    case "mid":
      smooth(midEq.gain, value);
      break;
    case "high":
      smooth(highEq.gain, value);
      break;
    case "bitDepth":
      bitcrusher.curve = createBitcrusherCurve(value);
      break;
    case "chorusRate":
      smooth(chorusLfo.frequency, value);
      break;
    case "chorusDepth":
      smooth(chorusDepth.gain, value / 1000);
      break;
    case "phaserRate":
      smooth(phaserLfo.frequency, value);
      break;
    case "phaserDepth":
      smooth(phaserDepth.gain, value);
      break;
    case "delayTime":
      smooth(delayNode.delayTime, value / 1000);
      break;
    case "delayFeedback":
      smooth(delayFeedback.gain, value / 100);
      break;
    case "delayMix":
      setEffectMix("delay", value);
      break;
    case "reverbDecay":
      clearTimeout(reverbUpdateTimer);
      reverbUpdateTimer = setTimeout(() => {
        if (audioContext && !reverbImpulseBuffer) {
          reverbConvolver.buffer = createReverbImpulse(value);
        }
      }, 160);
      break;
    case "reverbMix":
      setEffectMix("reverb", value);
      break;
    case "octaveLevel":
      updateOctaveOutputGain();
      break;
    case "cabLow":
      smooth(cabLow.frequency, value);
      break;
    case "cabHigh":
      smooth(cabHigh.frequency, value);
      break;
    case "limiterThreshold":
      smooth(limiter.threshold, value);
      break;
    case "master":
      smooth(masterGain.gain, value / 100);
      break;
  }
}

function formatParameter(parameter, value) {
  switch (parameter) {
    case "preamp":
    case "threshold":
    case "low":
    case "mid":
    case "high":
      return `${value > 0 ? "+" : ""}${value} dB`;
    case "ratio":
      return `${value}:1`;
    case "attack":
    case "chorusDepth":
      return `${value} ms`;
    case "release":
      return `${value} ms`;
    case "gateThreshold":
      return `${value} dB`;
    case "drive":
    case "master":
      return `${value}%`;
    case "bitDepth":
      return `${value} bit`;
    case "driveTone":
    case "cabHigh":
      return value >= 1000 ? `${(value / 1000).toFixed(value % 1000 ? 1 : 0)} kHz` : `${value} Hz`;
    case "chorusRate":
      return `${Number(value).toFixed(1)} Hz`;
    case "phaserRate":
      return `${Number(value).toFixed(1)} Hz`;
    case "phaserDepth":
      return `${value} Hz`;
    case "delayTime":
      return `${value} ms`;
    case "delayFeedback":
    case "delayMix":
    case "reverbMix":
      return `${value}%`;
    case "reverbDecay":
      return `${Number(value).toFixed(1)} s`;
    case "octaveLevel":
      return `${value}%`;
    case "limiterThreshold":
      return `${value} dB`;
    case "cabLow":
      return `${value} Hz`;
    default:
      return String(value);
  }
}

function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function exportPreset() {
  const parameters = Object.fromEntries(
    Array.from(document.querySelectorAll(".pedals-knob input"), (input) => [
      input.dataset.param,
      Number(input.value),
    ])
  );
  const effects = Object.fromEntries(
    Array.from(document.querySelectorAll("[data-toggle]"), (toggle) => [
      toggle.dataset.toggle,
      toggle.getAttribute("aria-pressed") === "true",
    ])
  );
  const preset = { format: "pedalsfx-preset", version: 1, parameters, effects };
  const blob = new Blob([JSON.stringify(preset, null, 2)], { type: "application/json" });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadFile(blob, `pedalsfx-preset-${timestamp}.json`);
  setImportStatus("Preset saved as a PedalsFX JSON file.");
}

function validatePreset(preset) {
  if (!preset || preset.format !== "pedalsfx-preset" || preset.version !== 1) {
    throw new Error("Unsupported PedalsFX preset format or version.");
  }
  if (!preset.parameters || typeof preset.parameters !== "object" || Array.isArray(preset.parameters)) {
    throw new Error("Preset has no valid parameter settings.");
  }
  if (!preset.effects || typeof preset.effects !== "object" || Array.isArray(preset.effects)) {
    throw new Error("Preset has no valid effect states.");
  }

  const controls = Array.from(document.querySelectorAll(".pedals-knob input"));
  const parameterNames = controls.map((input) => input.dataset.param);
  const effectNames = Array.from(document.querySelectorAll("[data-toggle]"), (toggle) => toggle.dataset.toggle);
  if (Object.keys(preset.parameters).length !== parameterNames.length ||
      parameterNames.some((name) => !Object.hasOwn(preset.parameters, name))) {
    throw new Error("Preset parameters do not match this PedalsFX version.");
  }
  if (Object.keys(preset.effects).length !== effectNames.length ||
      effectNames.some((name) => !Object.hasOwn(preset.effects, name))) {
    throw new Error("Preset effects do not match this PedalsFX version.");
  }

  controls.forEach((input) => {
    const value = preset.parameters[input.dataset.param];
    if (!Number.isFinite(value) || value < Number(input.min) || value > Number(input.max)) {
      throw new Error(`Preset value for ${input.dataset.param} is out of range.`);
    }
  });
  effectNames.forEach((name) => {
    if (typeof preset.effects[name] !== "boolean") {
      throw new Error(`Preset state for ${name} must be true or false.`);
    }
  });
  if (preset.effects.cabIR && !cabinetConvolver?.buffer && !importedImpulseFile) {
    throw new Error("This preset enables Cabinet IR. Import its IR WAV before applying the preset.");
  }
}

async function importPreset(file) {
  const preset = JSON.parse(await file.text());
  validatePreset(preset);

  document.querySelectorAll(".pedals-knob input").forEach((input) => {
    input.value = String(preset.parameters[input.dataset.param]);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  document.querySelectorAll("[data-toggle]").forEach((toggle) => {
    const enabled = preset.effects[toggle.dataset.toggle];
    if ((toggle.getAttribute("aria-pressed") === "true") !== enabled) toggle.click();
  });
  setImportStatus(`Loaded preset: ${file.name}.`);
}

async function importImpulseResponse(file) {
  if (!audioContext) {
    importedImpulseFile = file;
    setImportStatus(`Selected ${file.name}. Start the audio engine to load the IR.`);
    return;
  }
  if (file.size === 0 || file.size > 30 * 1024 * 1024) {
    throw new Error("IR WAV must be between 1 byte and 30 MB.");
  }
  const decoded = await audioContext.decodeAudioData(await file.arrayBuffer());
  if (decoded.duration > 10 || decoded.numberOfChannels > 2) {
    throw new Error("Use a mono or stereo impulse response no longer than 10 seconds.");
  }

  importedImpulseFile = file;
  const target = irTargetSelect.value;
  if (target === "cabinet" || target === "both") {
    cabinetImpulseBuffer = decoded;
    cabinetConvolver.buffer = decoded;
    setEffectEnabled("cabIR", true);
  }
  if (target === "reverb" || target === "both") {
    reverbImpulseBuffer = decoded;
    reverbConvolver.buffer = decoded;
    setEffectEnabled("reverb", true);
  }
  setImportStatus(`Loaded ${file.name} into ${target === "both" ? "cabinet and reverb" : target}.`);
}

document.querySelectorAll(".pedals-knob input").forEach((input) => {
  input.addEventListener("input", () => {
    const value = Number(input.value);
    input.closest(".pedals-knob").querySelector("output").textContent =
      formatParameter(input.dataset.param, value);
    updateParameter(input.dataset.param, value);
  });
});

document.querySelectorAll("[data-toggle]").forEach((toggle) => {
  toggle.addEventListener("click", () => {
    const name = toggle.dataset.toggle;
    const block = effectBlocks.get(name);
    const enabled = block ? !block.enabled : toggle.getAttribute("aria-pressed") !== "true";
    setEffectEnabled(name, enabled);
  });
});

savePresetButton.addEventListener("click", exportPreset);

presetFileInput.addEventListener("change", async () => {
  const [file] = presetFileInput.files || [];
  if (!file) return;
  try {
    await importPreset(file);
  } catch (error) {
    console.error("Could not import PedalsFX preset:", error);
    setImportStatus(`Could not load preset: ${error.message}`, true);
  } finally {
    presetFileInput.value = "";
  }
});

irFileInput.addEventListener("change", async () => {
  const [file] = irFileInput.files || [];
  if (!file) return;
  try {
    await importImpulseResponse(file);
  } catch (error) {
    console.error("Could not import the PedalsFX impulse response:", error);
    setImportStatus(`Could not load IR WAV: ${error.message}`, true);
  } finally {
    irFileInput.value = "";
  }
});

pedalsButton.addEventListener("click", () => {
  pedalsView.classList.remove("hidden");
  pedalsButton.setAttribute("aria-expanded", "true");
  refreshInputDevices().catch((error) => {
    console.error("Could not enumerate audio input devices:", error);
    setStatus("Could not list audio inputs. Check browser microphone permissions.", true);
  });
});

async function stopEngine() {
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  animationFrame = null;
  inputStream?.getTracks().forEach((track) => track.stop());
  inputSource?.disconnect();
  inputStream = null;
  inputSource = null;
  stopClipLoop();
  if (audioContext) {
    try {
      await audioContext.close();
    } catch (error) {
      console.error("Could not close the PedalsFX audio engine:", error);
    }
  }
  audioContext = null;
  inputGain = null;
  inputAnalyser = null;
  pitchAnalyser = null;
  outputAnalyser = null;
  masterGain = null;
  compressor = null;
  limiter = null;
  drive = null;
  driveTone = null;
  bitcrusher = null;
  gateGain = null;
  lowEq = null;
  midEq = null;
  highEq = null;
  chorusDelay = null;
  chorusDepth = null;
  chorusLfo = null;
  delayNode = null;
  delayFeedback = null;
  reverbConvolver = null;
  phaserFilters = [];
  phaserLfo = null;
  phaserDepth = null;
  octaveOscillator = null;
  octaveGain = null;
  cabLow = null;
  cabHigh = null;
  cabinetConvolver = null;
  pitchSamples = null;
  pitchBuffer = null;
  normalizedDifference = null;
  clipBuffer = null;
  cabinetImpulseBuffer = null;
  reverbImpulseBuffer = null;
  lastPitchCheck = 0;
  lastInputRms = 0;
  lastDetectedFrequency = null;
  gateIsOpen = true;
  clearTimeout(reverbUpdateTimer);
  reverbUpdateTimer = null;
  effectBlocks.clear();
  startButton.textContent = "Start Audio Engine";
  clipLoopButton.disabled = true;
  if (importedClipFile) setClipStatus("Clip kept. Start the engine to load and loop it.");
  pitchNote.textContent = "--";
  pitchStatus.textContent = "Start audio to detect a note.";
}

startButton.addEventListener("click", async () => {
  if (audioContext) {
    await stopEngine();
    setStatus("Audio engine stopped.");
    return;
  }

  if (!importedClipFile && !navigator.mediaDevices?.getUserMedia) {
    setStatus("Audio input requires a secure context (HTTPS or localhost) and a supported browser.", true);
    return;
  }

  startButton.disabled = true;
  setStatus("Requesting audio input permission…");
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    await audioContext.resume();
    createAudioGraph();
    if (importedClipFile) {
      await decodeImportedClip();
    } else {
      await requestInput();
      await audioContext.resume();
    }
    if (importedImpulseFile) await importImpulseResponse(importedImpulseFile);
    startButton.textContent = "Stop Audio Engine";
    const latency = audioContext.baseLatency
      ? `${(audioContext.baseLatency * 1000).toFixed(1)} ms base latency`
      : "interactive latency";
    const source = importedClipFile ? " · clip mode" : "";
    setStatus(`Audio engine running · ${audioContext.sampleRate} Hz · ${latency}${source}`);
    animationFrame = requestAnimationFrame(drawMeters);
  } catch (error) {
    console.error("PedalsFX could not start:", error);
    const messages = {
      NotAllowedError: "Microphone access was denied. Allow audio input access for this site and try again.",
      NotFoundError: "No audio input was found. Connect your USB-C interface and try again.",
      NotReadableError: "The selected audio input is busy or unavailable. Close other audio apps and try again.",
      OverconstrainedError: "The selected audio input is unavailable. Choose another device and try again.",
      SecurityError: "Audio input requires HTTPS (or localhost).",
    };
    setStatus(messages[error.name] || `Could not start the audio engine: ${error.message}`, true);
    await stopEngine();
  } finally {
    startButton.disabled = false;
  }
});

clipFileInput.addEventListener("change", async () => {
  const [file] = clipFileInput.files || [];
  if (!file) return;
  importedClipFile = file;
  clipBuffer = null;
  clipLoopButton.disabled = true;
  if (!audioContext) {
    setClipStatus(`Selected ${file.name}. Start the audio engine to load it.`);
    return;
  }
  try {
    stopClipLoop();
    setClipStatus(`Loading ${file.name}…`);
    await decodeImportedClip();
  } catch (error) {
    console.error("Could not decode the imported PedalsFX clip:", error);
    setClipStatus(`Could not load this audio file: ${error.message}`, true);
  }
});

clipLoopButton.addEventListener("click", () => {
  if (clipSource) stopClipLoop();
  else startClipLoop();
});

inputSelect.addEventListener("change", async () => {
  if (!audioContext) return;
  try {
    setStatus("Switching audio input…");
    await requestInput();
    setStatus("Audio input changed.");
  } catch (error) {
    console.error("Could not switch PedalsFX audio input:", error);
    setStatus(`Could not switch audio input: ${error.message}`, true);
  }
});

pedalsClose.addEventListener("click", async () => {
  await stopEngine();
  pedalsView.classList.add("hidden");
  pedalsButton.setAttribute("aria-expanded", "false");
  pedalsButton.focus();
});

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    refreshInputDevices().catch((error) => {
      console.error("Could not refresh audio input devices:", error);
      setStatus("Could not refresh audio inputs.", true);
    });
  });
}
