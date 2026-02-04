/// <reference lib="webworker" />

import * as MP4Box from "mp4box";

interface WorkerMessage {
  type: "start";
  file: ArrayBuffer;
  settings: {
    fps: number;
    resolution: number;
    quality: number;
    format: "png" | "jpeg" | "webp";
  };
  videoInfo: {
    width: number;
    height: number;
    duration: number;
    frameCount: number;
    frameRate: number;
  };
}

interface ProgressMessage {
  type: "progress";
  value: number;
}

interface FrameMessage {
  type: "frame";
  blob: Blob;
  index: number;
}

interface CompleteMessage {
  type: "complete";
  totalFrames: number;
}

interface ErrorMessage {
  type: "error";
  error: string;
  fallback?: boolean;
}

type OutgoingMessage = ProgressMessage | FrameMessage | CompleteMessage | ErrorMessage;

const ctx: Worker = self as unknown as Worker;

// Backpressure configuration - keep GPU busy with a buffer of chunks
const MAX_DECODE_QUEUE_SIZE = 15;
const TARGET_DECODE_QUEUE_SIZE = 10;

// Helper to wait for decoder to have capacity
const waitForDecoderCapacity = (decoder: VideoDecoder): Promise<void> => {
  return new Promise((resolve) => {
    if (decoder.decodeQueueSize <= TARGET_DECODE_QUEUE_SIZE) {
      resolve();
      return;
    }
    
    const checkQueue = () => {
      if (decoder.decodeQueueSize <= TARGET_DECODE_QUEUE_SIZE) {
        resolve();
      } else {
        decoder.addEventListener("dequeue", checkQueue, { once: true });
      }
    };
    
    decoder.addEventListener("dequeue", checkQueue, { once: true });
  });
};

const serializeMp4Box = (box: unknown): Uint8Array | undefined => {
  if (!box) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b: any = box;
  if (b instanceof Uint8Array) return b;
  if (b?.data instanceof Uint8Array) return b.data;
  if (b?.data instanceof ArrayBuffer) return new Uint8Array(b.data);
  if (b?.buffer instanceof ArrayBuffer && typeof b.byteOffset === "number" && typeof b.byteLength === "number") {
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  if (b?.buffer instanceof ArrayBuffer) return new Uint8Array(b.buffer);

  // Try to serialize via MP4Box's internal DataStream if available.
  if (typeof b?.write === "function") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const DataStreamCtor = (MP4Box as any).DataStream;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Endianness = (MP4Box as any).Endianness;
    if (DataStreamCtor) {
      try {
        const stream = new DataStreamCtor(undefined, 0, Endianness?.BIG_ENDIAN ?? 1);
        b.write(stream);
        const total = stream?.buffer as ArrayBuffer | undefined;
        const endPos = typeof stream?.position === "number" ? stream.position : undefined;
        if (total && endPos && endPos > 8) {
          return new Uint8Array(total.slice(8, endPos));
        }
        if (total && total.byteLength > 8) {
          return new Uint8Array(total.slice(8));
        }
      } catch {
        // ignore
      }
    }
  }

  return undefined;
};

const processVideo = async (data: WorkerMessage) => {
  const { file, settings, videoInfo } = data;
  
  const outputWidth = Math.round(videoInfo.width * (settings.resolution / 100));
  const outputHeight = Math.round(videoInfo.height * (settings.resolution / 100));
  
  // Use OffscreenCanvas for GPU-accelerated rendering
  const canvas = new OffscreenCanvas(outputWidth, outputHeight);
  const canvasCtx = canvas.getContext("2d");
  
  if (!canvasCtx) {
    postMessage({ type: "error", error: "Failed to create canvas context", fallback: true } as ErrorMessage);
    return;
  }
  
  const frameIntervalMicroseconds = 1000000 / settings.fps;
  let lastExtractedTimestamp = -frameIntervalMicroseconds;
  const targetFrameCount = Math.floor(videoInfo.duration * settings.fps);
  let processedFrameCount = 0;
  let frameIndex = 0;
  
  const mimeType = `image/${settings.format}`;
  const quality = settings.format === "png" ? undefined : settings.quality;
  
  const mp4boxFile = MP4Box.createFile();
  let videoTrackId: number | null = null;
  let trackTimescale = 1;
  let decoderClosed = false;
  let rejected = false;
  
  // Queue for pending samples to implement backpressure
  const sampleQueue: MP4Box.Sample[] = [];
  let processingQueue = false;
  
  const sendProgress = (count: number) => {
    const progress = Math.min((count / targetFrameCount) * 100, 100);
    postMessage({ type: "progress", value: progress } as ProgressMessage);
  };
  
  const fail = (err: unknown) => {
    if (rejected) return;
    rejected = true;
    
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mp4boxFile as any).stop?.();
    } catch {
      // ignore
    }
    
    try {
      if (!decoderClosed) {
        decoderClosed = true;
        decoder.close();
      }
    } catch {
      // ignore
    }
    
    const errorMessage = err instanceof Error ? err.message : String(err);
    postMessage({ type: "error", error: errorMessage, fallback: true } as ErrorMessage);
  };
  
  let resolveComplete: () => void;
  let rejectComplete: (err: unknown) => void;
  const completionPromise = new Promise<void>((resolve, reject) => {
    resolveComplete = resolve;
    rejectComplete = reject;
  });
  
  const decoder = new VideoDecoder({
    output: async (frame: VideoFrame) => {
      try {
        const timestamp = frame.timestamp;
        
        // Check if we should keep this frame based on target FPS
        if (timestamp - lastExtractedTimestamp >= frameIntervalMicroseconds * 0.9) {
          lastExtractedTimestamp = timestamp;
          
          // Draw frame to OffscreenCanvas (GPU-accelerated)
          canvasCtx.drawImage(frame, 0, 0, outputWidth, outputHeight);
          
          // Convert to blob using OffscreenCanvas (faster than regular canvas)
          const blob = await canvas.convertToBlob({ 
            type: mimeType, 
            quality: quality 
          });
          
          processedFrameCount++;
          frameIndex++;
          
          postMessage({ type: "frame", blob, index: frameIndex } as FrameMessage);
          sendProgress(processedFrameCount);
        }
        
        frame.close();
      } catch (e) {
        frame.close();
        console.error("Error processing frame:", e);
      }
    },
    error: (e) => {
      console.error("Decoder error:", e);
      if (!decoderClosed) {
        fail(e);
      }
    },
  });
  
  // Process samples with backpressure management
  const processSampleQueue = async () => {
    if (processingQueue) return;
    processingQueue = true;
    
    while (sampleQueue.length > 0) {
      // Wait for decoder to have capacity before feeding more samples
      // This keeps the GPU busy without overwhelming memory
      if (decoder.decodeQueueSize >= MAX_DECODE_QUEUE_SIZE) {
        await waitForDecoderCapacity(decoder);
      }
      
      const sample = sampleQueue.shift();
      if (!sample) break;
      
      try {
        const timestampUs = Math.floor(((sample.cts || 0) / trackTimescale) * 1000000);
        const durationUs = Math.floor(((sample.duration || 0) / trackTimescale) * 1000000);
        
        const chunk = new EncodedVideoChunk({
          type: sample.is_sync ? "key" : "delta",
          timestamp: timestampUs,
          duration: durationUs,
          data: sample.data!,
        });
        
        decoder.decode(chunk);
      } catch (e) {
        console.error("Error decoding sample:", e);
        fail(e);
        return;
      }
    }
    
    processingQueue = false;
  };
  
  mp4boxFile.onReady = (info: MP4Box.Movie) => {
    const videoTrack = info.tracks.find((track: MP4Box.Track) => track.type === "video");
    if (!videoTrack) {
      fail(new Error("No video track found"));
      return;
    }
    
    videoTrackId = videoTrack.id;
    trackTimescale = videoTrack.timescale;
    
    const codecString = videoTrack.codec;
    let description: Uint8Array | undefined;
    
    try {
      const trak = mp4boxFile.getTrackById(videoTrackId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry = (trak as any)?.mdia?.minf?.stbl?.stsd?.entries?.[0];
      
      if (entry) {
        if (entry.avcC) {
          description = serializeMp4Box(entry.avcC);
        } else if (entry.hvcC) {
          description = serializeMp4Box(entry.hvcC);
        }
      }
    } catch (e) {
      console.warn("Could not extract codec description:", e);
    }
    
    if (codecString.startsWith("avc") && !description) {
      console.warn("No AVC description found, falling back to legacy method");
      fail(new Error("AVC description required for WebCodecs"));
      return;
    }
    
    const codecConfig: VideoDecoderConfig = {
      codec: codecString,
      codedWidth: (videoTrack as { video?: { width: number; height: number } }).video?.width || videoInfo.width,
      codedHeight: (videoTrack as { video?: { width: number; height: number } }).video?.height || videoInfo.height,
      hardwareAcceleration: "prefer-hardware",
      description: description,
    };
    
    try {
      decoder.configure(codecConfig);
      // Request more samples at a time for better throughput
      mp4boxFile.setExtractionOptions(videoTrackId, null, { nbSamples: 200 });
      mp4boxFile.start();
    } catch (e) {
      fail(e);
    }
  };
  
  mp4boxFile.onSamples = (_trackId: number, _user: unknown, samples: MP4Box.Sample[]) => {
    // Add samples to queue instead of processing immediately
    sampleQueue.push(...samples);
    processSampleQueue();
  };
  
  mp4boxFile.onError = (_module: string, message: string) => {
    console.error("MP4Box error:", message);
    fail(new Error(message));
  };
  
  // Parse the file in chunks
  const chunkSize = 2 * 1024 * 1024; // 2MB chunks for better throughput
  let offset = 0;
  
  const processFile = async () => {
    while (offset < file.byteLength) {
      const end = Math.min(offset + chunkSize, file.byteLength);
      const chunk = file.slice(offset, end);
      
      const mp4Buffer = chunk as MP4Box.MP4BoxBuffer;
      mp4Buffer.fileStart = offset;
      mp4boxFile.appendBuffer(mp4Buffer);
      
      offset = end;
    }
    
    mp4boxFile.flush();
    
    // Wait for all samples in queue to be processed
    while (sampleQueue.length > 0) {
      await new Promise(r => setTimeout(r, 10));
    }
    
    // Wait for decoder to finish
    try {
      await decoder.flush();
      decoderClosed = true;
      decoder.close();
      resolveComplete();
    } catch (e) {
      rejectComplete(e);
    }
  };
  
  processFile().catch(fail);
  
  try {
    await completionPromise;
    postMessage({ type: "complete", totalFrames: frameIndex } as CompleteMessage);
  } catch (e) {
    fail(e);
  }
};

ctx.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  if (event.data.type === "start") {
    try {
      await processVideo(event.data);
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : String(e);
      postMessage({ type: "error", error: errorMessage, fallback: true } as ErrorMessage);
    }
  }
};

export {};
