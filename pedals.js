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

let audioContext = null;
let inputStream = null;
let inputSource = null;
let clipSource = null;
let clipBuffer = null;
let importedClipFile = null;
let inputGain = null;
let inputAnalyser = null;
let outputAnalyser = null;
let masterGain = null;
let compressor = null;
let drive = null;
let driveTone = null;
let lowEq = null;
let midEq = null;
let highEq = null;
let chorusDelay = null;
let chorusDepth = null;
let chorusLfo = null;
let cabLow = null;
let cabHigh = null;
let animationFrame = null;
const effectBlocks = new Map();

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.dataset.state = isError ? "error" : "ready";
}

function setClipStatus(message, isError = false) {
  clipStatus.textContent = message;
  clipStatus.dataset.state = isError ? "error" : "ready";
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

function createAudioGraph() {
  inputGain = audioContext.createGain();
  inputAnalyser = audioContext.createAnalyser();
  inputAnalyser.fftSize = 1024;
  outputAnalyser = audioContext.createAnalyser();
  outputAnalyser.fftSize = 1024;
  masterGain = audioContext.createGain();
  inputGain.gain.value = 10 ** (getControlValue("preamp") / 20);
  masterGain.gain.value = getControlValue("master") / 100;

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

  cabLow = audioContext.createBiquadFilter();
  cabLow.type = "highpass";
  cabLow.frequency.value = getControlValue("cabLow");
  cabLow.Q.value = 0.707;
  cabHigh = audioContext.createBiquadFilter();
  cabHigh.type = "lowpass";
  cabHigh.frequency.value = getControlValue("cabHigh");
  cabHigh.Q.value = 0.707;

  inputGain.connect(inputAnalyser);
  let previous = inputAnalyser;
  const chain = [
    ["compressor", [compressor], 1],
    ["drive", [drive, driveTone], 1],
    ["eq", [lowEq, midEq, highEq], 1],
    ["chorus", [chorusDelay], 0.35],
    ["cab", [cabLow, cabHigh], 1],
  ];

  chain.forEach(([name, nodes, mix]) => {
    const enabled = document.querySelector(`[data-toggle="${name}"]`).getAttribute("aria-pressed") === "true";
    const block = connectEffect(name, nodes, enabled, mix);
    previous.connect(block.input);
    previous = block.output;
  });

  previous.connect(masterGain);
  masterGain.connect(outputAnalyser);
  outputAnalyser.connect(audioContext.destination);
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

function drawMeters() {
  if (!audioContext || audioContext.state !== "running") return;
  drawScope(inputCanvas, inputAnalyser, inputLevel, inputReadout, "#00a8b5");
  drawScope(outputCanvas, outputAnalyser, outputLevel, outputReadout, "#d24683");
  animationFrame = requestAnimationFrame(drawMeters);
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
    case "chorusRate":
      smooth(chorusLfo.frequency, value);
      break;
    case "chorusDepth":
      smooth(chorusDepth.gain, value / 1000);
      break;
    case "cabLow":
      smooth(cabLow.frequency, value);
      break;
    case "cabHigh":
      smooth(cabHigh.frequency, value);
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
    case "drive":
    case "master":
      return `${value}%`;
    case "driveTone":
    case "cabHigh":
      return value >= 1000 ? `${(value / 1000).toFixed(value % 1000 ? 1 : 0)} kHz` : `${value} Hz`;
    case "chorusRate":
      return `${Number(value).toFixed(1)} Hz`;
    case "cabLow":
      return `${value} Hz`;
    default:
      return String(value);
  }
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
  outputAnalyser = null;
  masterGain = null;
  compressor = null;
  drive = null;
  driveTone = null;
  lowEq = null;
  midEq = null;
  highEq = null;
  chorusDelay = null;
  chorusDepth = null;
  chorusLfo = null;
  cabLow = null;
  cabHigh = null;
  effectBlocks.clear();
  startButton.textContent = "Start Audio Engine";
  clipLoopButton.disabled = true;
  if (importedClipFile) setClipStatus("Clip kept. Start the engine to load and loop it.");
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
