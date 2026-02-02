import { useRef, useCallback, useEffect } from 'react';

interface FrameTask {
  imageBitmap: ImageBitmap;
  outputWidth: number;
  outputHeight: number;
  format: 'png' | 'jpeg' | 'webp';
  quality: number;
  frameIndex: number;
  resolve: (blob: Blob) => void;
  reject: (error: Error) => void;
}

interface WorkerState {
  worker: Worker;
  busy: boolean;
}

const POOL_SIZE = navigator.hardwareConcurrency ? Math.min(navigator.hardwareConcurrency, 4) : 2;

export function useFrameProcessorPool() {
  const workersRef = useRef<WorkerState[]>([]);
  const queueRef = useRef<FrameTask[]>([]);
  const initializedRef = useRef(false);

  // Initialize worker pool
  const initPool = useCallback(() => {
    if (initializedRef.current) return;
    
    // Check if OffscreenCanvas is supported
    if (typeof OffscreenCanvas === 'undefined') {
      console.warn('OffscreenCanvas not supported, worker pool disabled');
      return;
    }

    for (let i = 0; i < POOL_SIZE; i++) {
      const worker = new Worker(
        new URL('../workers/frameProcessor.worker.ts', import.meta.url),
        { type: 'module' }
      );

      const workerState: WorkerState = {
        worker,
        busy: false,
      };

      worker.onmessage = (event) => {
        const message = event.data;

        if (message.type === 'ready') {
          // Worker is initialized
          return;
        }

        if (message.type === 'frameProcessed') {
          // Find the task in progress and resolve it
          workerState.busy = false;
          processNextTask(workerState);
        }

        if (message.type === 'error') {
          workerState.busy = false;
          processNextTask(workerState);
        }
      };

      worker.postMessage({ type: 'init' });
      workersRef.current.push(workerState);
    }

    initializedRef.current = true;
  }, []);

  const processNextTask = useCallback((workerState: WorkerState) => {
    if (queueRef.current.length === 0) return;
    if (workerState.busy) return;

    const task = queueRef.current.shift()!;
    workerState.busy = true;

    // Set up one-time message handler for this specific task
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      
      if (message.type === 'frameProcessed' && message.frameIndex === task.frameIndex) {
        workerState.worker.removeEventListener('message', handleMessage);
        task.resolve(message.blob);
      }
      
      if (message.type === 'error' && message.frameIndex === task.frameIndex) {
        workerState.worker.removeEventListener('message', handleMessage);
        task.reject(new Error(message.error));
      }
    };

    workerState.worker.addEventListener('message', handleMessage);

    workerState.worker.postMessage({
      type: 'processFrame',
      imageBitmap: task.imageBitmap,
      outputWidth: task.outputWidth,
      outputHeight: task.outputHeight,
      format: task.format,
      quality: task.quality,
      frameIndex: task.frameIndex,
    }, [task.imageBitmap]); // Transfer the ImageBitmap
  }, []);

  const processFrame = useCallback((
    imageBitmap: ImageBitmap,
    outputWidth: number,
    outputHeight: number,
    format: 'png' | 'jpeg' | 'webp',
    quality: number,
    frameIndex: number
  ): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const task: FrameTask = {
        imageBitmap,
        outputWidth,
        outputHeight,
        format,
        quality,
        frameIndex,
        resolve,
        reject,
      };

      queueRef.current.push(task);

      // Try to find an available worker
      for (const workerState of workersRef.current) {
        if (!workerState.busy) {
          processNextTask(workerState);
          break;
        }
      }
    });
  }, [processNextTask]);

  const isSupported = useCallback(() => {
    return typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined';
  }, []);

  const getPoolSize = useCallback(() => {
    return workersRef.current.length;
  }, []);

  // Cleanup workers on unmount
  useEffect(() => {
    return () => {
      for (const workerState of workersRef.current) {
        workerState.worker.terminate();
      }
      workersRef.current = [];
      queueRef.current = [];
      initializedRef.current = false;
    };
  }, []);

  return {
    initPool,
    processFrame,
    isSupported,
    getPoolSize,
  };
}
