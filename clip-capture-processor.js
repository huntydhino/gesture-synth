class RecentClipCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacityFrames = sampleRate * 30;
    this.leftRing = new Float32Array(this.capacityFrames);
    this.rightRing = new Float32Array(this.capacityFrames);
    this.writeIndex = 0;
    this.framesWritten = 0;

    this.port.onmessage = (event) => {
      if (event.data.type !== "get-clip") return;
      this.sendRecentClip(event.data.frames);
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    output?.forEach((channel) => channel.fill(0));
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const left = input[0];
    const right = input[1] || left;
    for (let frame = 0; frame < left.length; frame += 1) {
      this.leftRing[this.writeIndex] = left[frame];
      this.rightRing[this.writeIndex] = right[frame];
      this.writeIndex = (this.writeIndex + 1) % this.capacityFrames;
    }
    this.framesWritten = Math.min(this.capacityFrames, this.framesWritten + left.length);
    return true;
  }

  sendRecentClip(requestedFrames) {
    const frames = Math.min(this.framesWritten, requestedFrames, this.capacityFrames);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    const startIndex = (this.writeIndex - frames + this.capacityFrames) % this.capacityFrames;
    const firstPartLength = Math.min(frames, this.capacityFrames - startIndex);
    left.set(this.leftRing.subarray(startIndex, startIndex + firstPartLength));
    right.set(this.rightRing.subarray(startIndex, startIndex + firstPartLength));

    const remaining = frames - firstPartLength;
    if (remaining > 0) {
      left.set(this.leftRing.subarray(0, remaining), firstPartLength);
      right.set(this.rightRing.subarray(0, remaining), firstPartLength);
    }

    this.port.postMessage({
      type: "clip-data",
      left: left.buffer,
      right: right.buffer,
      sampleRate,
      frames,
    }, [left.buffer, right.buffer]);
  }
}

registerProcessor("recent-clip-capture", RecentClipCaptureProcessor);
