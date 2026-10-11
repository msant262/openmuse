import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

export type SpeechRequest = { text: string; voice: string; timeoutMs: number };
export type SpeechGenerator = (args: SpeechRequest, signal?: AbortSignal) => Promise<Uint8Array>;

/** Inspect complete MPEG Layer III frames, not a filename or the first magic bytes.
 * Includes ID3v2/tag padding and derives duration from the encoded frame samples. */
export function inspectMp3(bytes: Uint8Array) {
  let offset = 0,
    samples = 0,
    durationSeconds = 0,
    frames = 0;
  if (Buffer.from(bytes.subarray(0, 3)).toString() === "ID3") {
    if (bytes.length < 10 || [6, 7, 8, 9].some((i) => bytes[i] > 127))
      throw new Error("Invalid MP3 tag");
    offset = 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]);
    if (bytes[5] & 16) offset += 10;
  }
  while (offset < bytes.length) {
    if (
      bytes.length - offset === 128 &&
      Buffer.from(bytes.subarray(offset, offset + 3)).toString() === "TAG"
    ) {
      offset += 128;
      break;
    }
    if (offset + 4 > bytes.length || bytes[offset] !== 255 || (bytes[offset + 1] & 224) !== 224)
      throw new Error("Incomplete or invalid MP3 audio");
    const version = (bytes[offset + 1] >> 3) & 3;
    const layer = (bytes[offset + 1] >> 1) & 3;
    const bitrateIndex = bytes[offset + 2] >> 4;
    const rateIndex = (bytes[offset + 2] >> 2) & 3;
    if (version === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15 || rateIndex === 3)
      throw new Error("Invalid MP3 frame");
    const rates =
      version === 3
        ? [44100, 48000, 32000]
        : version === 2
          ? [22050, 24000, 16000]
          : [11025, 12000, 8000];
    const bitrates =
      version === 3
        ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
        : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
    const rate = rates[rateIndex];
    const frameSize =
      Math.floor(((version === 3 ? 144 : 72) * bitrates[bitrateIndex] * 1000) / rate) +
      ((bytes[offset + 2] >> 1) & 1);
    if (offset + frameSize > bytes.length) throw new Error("Truncated MP3 audio");
    const frameSamples = version === 3 ? 1152 : 576;
    samples += frameSamples;
    durationSeconds += frameSamples / rate;
    frames++;
    offset += frameSize;
  }
  if (frames < 2 || !samples || offset !== bytes.length)
    throw new Error("No complete MP3 audio was generated");
  return { durationSeconds: Math.round(durationSeconds * 1000) / 1000, frames };
}

// OpenClaw's Microsoft provider and Hermes's free Edge default use the same
// service. The pinned SDK is isolated because its own timeout doesn't close
// its socket. Termination is awaited before task cancellation can release work.
const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { EdgeTTS } = require(workerData.sdk);
const { readFile, stat } = require('node:fs/promises');
const { join } = require('node:path');
(async () => {
  const chunks = [];
  let size = 0;
  // Bound the XML websocket frame while retaining every input character.
  const characters = Array.from(workerData.text);
  for (let i = 0; i < characters.length;) {
    let end = Math.min(i + 2500, characters.length);
    if (end < characters.length) {
      for (let boundary = end; boundary > i + 1250; boundary--) {
        if (/\s/.test(characters[boundary - 1])) { end = boundary; break; }
      }
    }
    const path = join(workerData.directory, 'part-' + i + '.mp3');
    const tts = new EdgeTTS({ voice: workerData.voice, lang: workerData.voice.split('-').slice(0, 2).join('-'), outputFormat: 'audio-24khz-48kbitrate-mono-mp3', timeout: workerData.timeoutMs });
    await tts.ttsPromise(characters.slice(i, end).join(''), path);
    const length = (await stat(path)).size;
    if (!length || size + length > 16 * 1024 * 1024) throw new Error('Speech output is empty or exceeds 16 MB');
    size += length; chunks.push(await readFile(path));
    i = end;
  }
  const bytes = Buffer.concat(chunks);
  await require('node:fs/promises').writeFile(join(workerData.directory, 'speech.mp3'), bytes, {mode: 0o600});
  parentPort.postMessage({ok: true});
})().catch(error => {
  const status = /Unexpected server response: (\d{3})/.exec(String(error?.message));
  const reason = status ? 'Microsoft speech service rejected the connection (HTTP ' + status[1] + ')' : String(error?.message ?? error) === 'Timed out' ? 'Microsoft speech service timed out' : 'Microsoft speech generation failed';
  parentPort.postMessage({error: reason + '; no audio was delivered'});
});
`;

export const synthesizeSpeech: SpeechGenerator = async (args, signal) => {
  signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "okami-speech-"));
  let worker: Worker | undefined;
  try {
    signal?.throwIfAborted();
    worker = new Worker(workerSource, {
      eval: true,
      workerData: { ...args, directory, sdk: fileURLToPath(import.meta.resolve("node-edge-tts")) },
    });
    const active = worker;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () => finish(signal?.reason ?? new Error("Speech generation cancelled"));
      const timer = setTimeout(
        () => finish(new Error("Speech generation timed out; no audio was delivered")),
        args.timeoutMs,
      );
      active.on("message", (result) =>
        finish(
          result?.ok === true ? undefined : new Error(result?.error ?? "Speech generation failed"),
        ),
      );
      active.on("error", () => finish(new Error("Speech generator unavailable")));
      active.on("exit", () => {
        if (!settled) finish(new Error("Speech generator stopped before delivering audio"));
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    signal?.throwIfAborted();
    const bytes = new Uint8Array(await readFile(join(directory, "speech.mp3")));
    inspectMp3(bytes);
    return bytes;
  } finally {
    if (worker) await worker.terminate();
    await rm(directory, { recursive: true, force: true });
  }
};
