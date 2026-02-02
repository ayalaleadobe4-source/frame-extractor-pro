// Web Worker for parallel frame processing using OffscreenCanvas
// This runs off the main thread, preventing UI freezing

interface ProcessFrameMessage {
  type: 'processFrame';
  imageBitmap: ImageBitmap;
  outputWidth: number;
  outputHeight: number;
  format: 'png' | 'jpeg' | 'webp';
  quality: number;
  frameIndex: number;
}

interface InitMessage {
  type: 'init';
}

type WorkerMessage = ProcessFrameMessage | InitMessage;

interface FrameResultMessage {
  type: 'frameProcessed';
  blob: Blob;
  frameIndex: number;
}

interface ErrorMessage {
  type: 'error';
  error: string;
  frameIndex?: number;
}

interface ReadyMessage {
  type: 'ready';
}

type WorkerResponse = FrameResultMessage | ErrorMessage | ReadyMessage;

let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  if (message.type === 'init') {
    // Worker is ready
    const response: ReadyMessage = { type: 'ready' };
    self.postMessage(response);
    return;
  }

  if (message.type === 'processFrame') {
    try {
      const { imageBitmap, outputWidth, outputHeight, format, quality, frameIndex } = message;

      // Create or resize canvas as needed
      if (!canvas || canvas.width !== outputWidth || canvas.height !== outputHeight) {
        canvas = new OffscreenCanvas(outputWidth, outputHeight);
        ctx = canvas.getContext('2d');
      }

      if (!ctx) {
        throw new Error('Failed to get 2D context');
      }

      // Draw the ImageBitmap to the OffscreenCanvas
      ctx.drawImage(imageBitmap, 0, 0, outputWidth, outputHeight);
      
      // Close the ImageBitmap to free memory
      imageBitmap.close();

      // Convert to blob
      const mimeType = `image/${format}`;
      const blob = await canvas.convertToBlob({
        type: mimeType,
        quality: format === 'png' ? undefined : quality,
      });

      const response: FrameResultMessage = {
        type: 'frameProcessed',
        blob,
        frameIndex,
      };
      self.postMessage(response);
    } catch (error) {
      const response: ErrorMessage = {
        type: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        frameIndex: message.frameIndex,
      };
      self.postMessage(response);
    }
  }
};

export type { WorkerMessage, WorkerResponse, ProcessFrameMessage };
