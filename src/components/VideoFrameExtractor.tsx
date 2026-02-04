import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Upload, Download, Film, Settings, Image as ImageIcon, Loader2, Zap, X } from "lucide-react";
import JSZip from "jszip";
import * as MP4Box from "mp4box";

interface VideoInfo {
  width: number;
  height: number;
  duration: number;
  frameCount: number;
  frameRate: number;
}

interface ExtractionSettings {
  fps: number;
  resolution: number;
  quality: number;
  format: "png" | "jpeg" | "webp";
}

// Using mp4box types directly - cast as needed

const VideoFrameExtractor = () => {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionProgress, setExtractionProgress] = useState(0);
  const [extractedFrames, setExtractedFrames] = useState<Blob[]>([]);
  const [useWebCodecs, setUseWebCodecs] = useState<boolean | null>(null);
  const [extractionMethod, setExtractionMethod] = useState<string>("");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [settings, setSettings] = useState<ExtractionSettings>({
    fps: 1,
    resolution: 100,
    quality: 0.9,
    format: "png",
  });
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [saveMethod, setSaveMethod] = useState<"zip" | "folder">("zip");
  const [isCreatingOutput, setIsCreatingOutput] = useState(false);

  // Check WebCodecs support
  const supportsWebCodecs = useCallback(() => {
    return 'VideoDecoder' in window && 'EncodedVideoChunk' in window;
  }, []);

  const getVideoFpsFromFile = async (file: File): Promise<{ fps: number; frameCount: number; codec?: string; trackId?: number } | null> => {
    return new Promise((resolve) => {
      const mp4boxFile = MP4Box.createFile();
      
      mp4boxFile.onReady = (info: MP4Box.Movie) => {
        const videoTrack = info.tracks.find((track: MP4Box.Track) => track.type === "video");
        if (videoTrack) {
          const fps = videoTrack.nb_samples / (videoTrack.duration / videoTrack.timescale);
          const frameCount = videoTrack.nb_samples;
          resolve({ 
            fps: Math.round(fps * 100) / 100, 
            frameCount,
            codec: videoTrack.codec,
            trackId: videoTrack.id
          });
        } else {
          resolve(null);
        }
      };

      mp4boxFile.onError = () => {
        resolve(null);
      };

      const reader = new FileReader();
      reader.onload = () => {
        const buffer = reader.result as ArrayBuffer;
        const mp4Buffer = buffer as MP4Box.MP4BoxBuffer;
        mp4Buffer.fileStart = 0;
        mp4boxFile.appendBuffer(mp4Buffer);
        mp4boxFile.flush();
      };
      reader.onerror = () => resolve(null);
      reader.readAsArrayBuffer(file);
    });
  };

  // WebCodecs-based fast extraction
  const extractFramesWebCodecs = async (
    file: File,
    videoInfo: VideoInfo,
    settings: ExtractionSettings,
    onProgress: (progress: number, currentFrame: number, totalFrames: number) => void,
    signal?: AbortSignal
  ): Promise<Blob[]> => {
    return new Promise((resolve, reject) => {
      // Check for cancellation at start
      if (signal?.aborted) {
        reject(new DOMException("Extraction cancelled", "AbortError"));
        return;
      }
      const frames: Blob[] = [];
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d")!;

      const outputWidth = Math.round(videoInfo.width * (settings.resolution / 100));
      const outputHeight = Math.round(videoInfo.height * (settings.resolution / 100));
      canvas.width = outputWidth;
      canvas.height = outputHeight;

      const frameIntervalMicroseconds = (1000000 / settings.fps);
      let lastExtractedTimestamp = -frameIntervalMicroseconds;
      const targetFrameCount = Math.floor(videoInfo.duration * settings.fps);
      let processedFrameCount = 0;
      
      const mimeType = `image/${settings.format}`;
      const quality = settings.format === "png" ? undefined : settings.quality;

      const pendingBlobs: Promise<void>[] = [];
      let decoderClosed = false;

      const mp4boxFile = MP4Box.createFile();
      let videoTrackId: number | null = null;
      let codecConfig: VideoDecoderConfig | null = null;

      let rejected = false;
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
          decoderClosed = true;
          decoder.close();
        } catch {
          // ignore
        }
        reject(err);
      };

      // Listen for abort signal
      const abortHandler = () => {
        fail(new DOMException("Extraction cancelled", "AbortError"));
      };
      signal?.addEventListener("abort", abortHandler, { once: true });

      const decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          const timestamp = frame.timestamp;
          
          // Check if we should keep this frame based on target FPS
          if (timestamp - lastExtractedTimestamp >= frameIntervalMicroseconds * 0.9) {
            lastExtractedTimestamp = timestamp;
            
            ctx.drawImage(frame, 0, 0, outputWidth, outputHeight);
            
            const blobPromise = new Promise<void>((resolveBlob) => {
              canvas.toBlob(
                (blob) => {
                  if (blob) {
                    frames.push(blob);
                    processedFrameCount++;
                    onProgress((processedFrameCount / targetFrameCount) * 100, processedFrameCount, targetFrameCount);
                  }
                  resolveBlob();
                },
                mimeType,
                quality
              );
            });
            pendingBlobs.push(blobPromise);
          }
          
          frame.close();
        },
        error: (e) => {
          console.error("Decoder error:", e);
          if (!decoderClosed) {
            fail(e);
          }
        },
      });

      let trackTimescale = 1;
      
      mp4boxFile.onReady = (info: MP4Box.Movie) => {
        const videoTrack = info.tracks.find((track: MP4Box.Track) => track.type === "video");
        if (!videoTrack) {
          reject(new Error("No video track found"));
          return;
        }

        videoTrackId = videoTrack.id;
        trackTimescale = videoTrack.timescale;
        
        // Build codec string for WebCodecs
        const codecString = videoTrack.codec;
        
        // Extract description (avcC/hvcC) for H.264/HEVC codecs
        let description: Uint8Array | undefined;

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
          // This usually writes a full MP4 box (size+type+payload), so we strip the 8-byte header.
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
        
        try {
          // Get the track box to access codec-specific configuration
          const trak = mp4boxFile.getTrackById(videoTrackId);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const entry = (trak as any)?.mdia?.minf?.stbl?.stsd?.entries?.[0];
          
          if (entry) {
            // For H.264 (AVC) - avcC box contains SPS/PPS
            if (entry.avcC) {
              description = serializeMp4Box(entry.avcC);
            }
            // For HEVC - hvcC box
            else if (entry.hvcC) {
              description = serializeMp4Box(entry.hvcC);
            }
          }
        } catch (e) {
          console.warn("Could not extract codec description:", e);
        }
        
        // For AVC codecs, description is required
        if (codecString.startsWith("avc") && !description) {
          console.warn("No AVC description found, falling back to legacy method");
          fail(new Error("AVC description required for WebCodecs"));
          return;
        }
        
        codecConfig = {
          codec: codecString,
          codedWidth: (videoTrack as { video?: { width: number; height: number } }).video?.width || videoInfo.width,
          codedHeight: (videoTrack as { video?: { width: number; height: number } }).video?.height || videoInfo.height,
          hardwareAcceleration: "prefer-hardware" as HardwareAcceleration,
          description: description,
        };

        try {
          decoder.configure(codecConfig);
          mp4boxFile.setExtractionOptions(videoTrackId, null, { nbSamples: 100 });
          mp4boxFile.start();
        } catch (e) {
          fail(e);
        }
      };

      mp4boxFile.onSamples = (_trackId: number, _user: unknown, samples: MP4Box.Sample[]) => {
        for (const sample of samples) {
          try {
            // Convert from track timescale to microseconds
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
            // If WebCodecs decoding fails (common with missing/invalid description or keyframe requirements),
            // stop this path so the caller can fall back to the legacy extractor.
            fail(e);
            return;
          }
        }
      };

      mp4boxFile.onError = (_module: string, message: string) => {
        console.error("MP4Box error:", message);
        fail(new Error(message));
      };

      // Read file in chunks for better performance
      const chunkSize = 1024 * 1024; // 1MB chunks
      let offset = 0;

      const readNextChunk = () => {
        if (offset >= file.size) {
          mp4boxFile.flush();
          
          // Wait for decoder to finish
          decoder.flush().then(async () => {
            decoderClosed = true;
            decoder.close();
            signal?.removeEventListener("abort", abortHandler);
            await Promise.all(pendingBlobs);
            resolve(frames);
          }).catch((e) => {
            signal?.removeEventListener("abort", abortHandler);
            reject(e);
          });
          return;
        }

        const slice = file.slice(offset, offset + chunkSize);
        const reader = new FileReader();
        
        reader.onload = () => {
          const buffer = reader.result as ArrayBuffer;
          const mp4Buffer = buffer as MP4Box.MP4BoxBuffer;
          mp4Buffer.fileStart = offset;
          mp4boxFile.appendBuffer(mp4Buffer);
          offset += chunkSize;
          readNextChunk();
        };
        
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsArrayBuffer(slice);
      };

      readNextChunk();
    });
  };

  // Fallback: Legacy seek-based extraction
  const extractFramesLegacy = async (
    videoInfo: VideoInfo,
    settings: ExtractionSettings,
    onProgress: (progress: number, currentFrame: number, totalFrames: number) => void,
    signal?: AbortSignal
  ): Promise<Blob[]> => {
    const video = videoRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    const outputWidth = Math.round(videoInfo.width * (settings.resolution / 100));
    const outputHeight = Math.round(videoInfo.height * (settings.resolution / 100));
    canvas.width = outputWidth;
    canvas.height = outputHeight;

    const framesToExtract = Math.floor(videoInfo.duration * settings.fps);
    const frameInterval = 1 / settings.fps;
    const frames: Blob[] = [];

    video.currentTime = 0;

    for (let i = 0; i < framesToExtract; i++) {
      // Check for cancellation
      if (signal?.aborted) {
        throw new DOMException("Extraction cancelled", "AbortError");
      }

      const targetTime = i * frameInterval;
      
      await new Promise<void>((resolve) => {
        video.currentTime = targetTime;
        video.onseeked = () => resolve();
      });

      ctx.drawImage(video, 0, 0, outputWidth, outputHeight);

      const mimeType = `image/${settings.format}`;
      const quality = settings.format === "png" ? undefined : settings.quality;

      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob(
          (blob) => resolve(blob!),
          mimeType,
          quality
        );
      });

      frames.push(blob);
      onProgress(((i + 1) / framesToExtract) * 100, i + 1, framesToExtract);
    }

    return frames;
  };

  const analyzeVideo = useCallback(async (file: File) => {
    setIsAnalyzing(true);
    const url = URL.createObjectURL(file);
    setVideoUrl(url);

    // Check WebCodecs support
    const webCodecsSupported = supportsWebCodecs();
    setUseWebCodecs(webCodecsSupported);

    // Try to get FPS from MP4Box first
    const mp4Info = await getVideoFpsFromFile(file);

    return new Promise<VideoInfo>((resolve) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.src = url;

      video.onloadedmetadata = () => {
        const duration = video.duration;
        const width = video.videoWidth;
        const height = video.videoHeight;
        
        const detectedFps = mp4Info?.fps || 30;
        const frameCount = mp4Info?.frameCount || Math.floor(duration * detectedFps);

        const info: VideoInfo = {
          width,
          height,
          duration,
          frameCount,
          frameRate: detectedFps,
        };

        setVideoInfo(info);
        setSettings((prev) => ({
          ...prev,
          fps: Math.min(prev.fps, Math.floor(detectedFps)),
        }));
        setIsAnalyzing(false);
        resolve(info);
      };
    });
  }, [supportsWebCodecs]);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && file.type.startsWith("video/")) {
      setVideoFile(file);
      setExtractedFrames([]);
      setExtractionProgress(0);
      setExtractionMethod("");
      setStatusMessage("");
      await analyzeVideo(file);
    }
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file && file.type.startsWith("video/")) {
      setVideoFile(file);
      setExtractedFrames([]);
      setExtractionProgress(0);
      setExtractionMethod("");
      setStatusMessage("");
      await analyzeVideo(file);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const extractFrames = async () => {
    if (!videoFile || !videoInfo) return;

    setIsExtracting(true);
    setIsCancelling(false);
    setExtractedFrames([]);
    setExtractionProgress(0);
    setStatusMessage("קורא את הקובץ...");

    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    const onProgress = (progress: number, currentFrame: number, totalFrames: number) => {
      setExtractionProgress(Math.min(progress, 100));
      setStatusMessage(`חולצו ${currentFrame.toLocaleString()} מתוך ${totalFrames.toLocaleString()} פריימים`);
    };

    try {
      let frames: Blob[];
      
      // Try WebCodecs first for MP4 files
      const isMp4 = videoFile.type === "video/mp4" || videoFile.name.toLowerCase().endsWith(".mp4");
      
      if (useWebCodecs && isMp4) {
        setExtractionMethod("WebCodecs (GPU מואץ)");
        try {
          frames = await extractFramesWebCodecs(videoFile, videoInfo, settings, onProgress, signal);
        } catch (e) {
          if (signal.aborted) throw e;
          console.warn("WebCodecs extraction failed, falling back to legacy:", e);
          setExtractionMethod("Legacy (CPU)");
          setStatusMessage("קורא את הקובץ...");
          frames = await extractFramesLegacy(videoInfo, settings, onProgress, signal);
        }
      } else {
        setExtractionMethod("Legacy (CPU)");
        frames = await extractFramesLegacy(videoInfo, settings, onProgress, signal);
      }

      if (!signal.aborted) {
        if (saveMethod === "zip") {
          setStatusMessage("יוצר קובץ ZIP...");
          setExtractedFrames(frames);
          
          // Small delay to show the "creating ZIP" message
          await new Promise(resolve => setTimeout(resolve, 300));
          setStatusMessage("הושלם בהצלחה!");
        } else {
          // For folder save, save directly
          setIsCreatingOutput(true);
          setStatusMessage("שומר קבצים לתיקייה...");
          await saveFramesToFolder(frames);
          setStatusMessage("הקבצים נשמרו בהצלחה!");
          setIsCreatingOutput(false);
          // Clear frames to save memory since they're already saved
          setExtractedFrames([]);
        }
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        console.log("Extraction cancelled by user");
        setStatusMessage("החילוץ בוטל");
      } else {
        console.error("Extraction failed:", e);
        setStatusMessage("שגיאה בחילוץ");
      }
    } finally {
      setIsExtracting(false);
      setIsCancelling(false);
      setIsCreatingOutput(false);
      abortControllerRef.current = null;
    }
  };

  const cancelExtraction = () => {
    if (abortControllerRef.current) {
      setIsCancelling(true);
      setStatusMessage("מבטל...");
      abortControllerRef.current.abort();
    }
  };

  const downloadAsZip = async () => {
    if (extractedFrames.length === 0) return;

    setStatusMessage("יוצר קובץ ZIP להורדה...");

    const zip = new JSZip();
    const folder = zip.folder("frames");

    extractedFrames.forEach((blob, index) => {
      const paddedIndex = String(index + 1).padStart(5, "0");
      folder?.file(`frame_${paddedIndex}.${settings.format}`, blob);
    });

    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    const a = document.createElement("a");
    a.href = url;
    a.download = `frames_${videoFile?.name.split(".")[0] || "video"}.zip`;
    a.click();
    URL.revokeObjectURL(url);

    setStatusMessage("הושלם בהצלחה!");
  };

  const saveFramesToFolder = async (frames: Blob[]) => {
    try {
      // Check if File System Access API is supported
      if (!('showDirectoryPicker' in window)) {
        alert("הדפדפן שלך לא תומך בשמירה ישירה לתיקייה. אנא השתמש באפשרות ZIP.");
        return;
      }

      // Request directory access
      const dirHandle = await (window as Window & { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
      
      // Create a subdirectory for frames
      const framesFolderName = `frames_${videoFile?.name.split(".")[0] || "video"}`;
      const framesDir = await dirHandle.getDirectoryHandle(framesFolderName, { create: true });

      // Save each frame
      for (let i = 0; i < frames.length; i++) {
        const paddedIndex = String(i + 1).padStart(5, "0");
        const fileName = `frame_${paddedIndex}.${settings.format}`;
        
        const fileHandle = await framesDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(frames[i]);
        await writable.close();

        // Update progress
        const progress = ((i + 1) / frames.length) * 100;
        setExtractionProgress(progress);
        setStatusMessage(`נשמר ${i + 1} מתוך ${frames.length} קבצים לתיקייה`);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        console.log("User cancelled folder selection");
        setStatusMessage("בחירת התיקייה בוטלה");
      } else {
        console.error("Error saving to folder:", err);
        alert("שגיאה בשמירת הקבצים לתיקייה");
        setStatusMessage("שגיאה בשמירה");
      }
      throw err;
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const estimatedFrames = videoInfo
    ? Math.floor(videoInfo.duration * settings.fps)
    : 0;

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl md:text-4xl font-bold text-foreground">
            מחלץ פריימים מווידאו
          </h1>
          <p className="text-muted-foreground">
            העלה וידאו, בחר הגדרות והורד את כל הפריימים כקובץ ZIP
          </p>
          {useWebCodecs !== null && (
            <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-sm ${
              useWebCodecs 
                ? "bg-green-500/10 text-green-600 dark:text-green-400" 
                : "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
            }`}>
              <Zap className="w-4 h-4" />
              {useWebCodecs 
                ? "WebCodecs זמין - חילוץ מהיר עם GPU" 
                : "WebCodecs לא נתמך - שימוש בשיטה רגילה"}
            </div>
          )}
        </div>

        {/* Upload Zone */}
        <Card
          className={`upload-zone p-8 border-2 border-dashed transition-all cursor-pointer ${
            videoFile ? "border-primary/50 bg-primary/5" : "border-border hover:border-primary/30"
          }`}
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            onChange={handleFileSelect}
            className="hidden"
          />
          <div className="flex flex-col items-center justify-center gap-4">
            {isAnalyzing ? (
              <>
                <Loader2 className="w-12 h-12 text-primary animate-spin" />
                <p className="text-muted-foreground">מנתח את הווידאו...</p>
              </>
            ) : videoFile ? (
              <>
                <Film className="w-12 h-12 text-primary" />
                <div className="text-center">
                  <p className="font-medium text-foreground">{videoFile.name}</p>
                  <p className="text-sm text-muted-foreground">
                    לחץ להחלפת קובץ
                  </p>
                </div>
              </>
            ) : (
              <>
                <Upload className="w-12 h-12 text-muted-foreground" />
                <div className="text-center">
                  <p className="font-medium text-foreground">
                    גרור ושחרר וידאו כאן
                  </p>
                  <p className="text-sm text-muted-foreground">
                    או לחץ לבחירת קובץ
                  </p>
                </div>
              </>
            )}
          </div>
        </Card>

        {/* Video Info */}
        {videoInfo && (
          <Card className="p-6 video-info-card">
            <div className="flex items-center gap-2 mb-4">
              <Film className="w-5 h-5 text-primary" />
              <h2 className="font-semibold text-lg">מידע על הווידאו</h2>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="info-stat">
                <p className="text-sm text-muted-foreground">רזולוציה</p>
                <p className="font-bold text-xl">
                  {videoInfo.width}×{videoInfo.height}
                </p>
              </div>
              <div className="info-stat">
                <p className="text-sm text-muted-foreground">משך</p>
                <p className="font-bold text-xl">
                  {formatDuration(videoInfo.duration)}
                </p>
              </div>
              <div className="info-stat">
                <p className="text-sm text-muted-foreground">קצב פריימים</p>
                <p className="font-bold text-xl">{videoInfo.frameRate} FPS</p>
              </div>
              <div className="info-stat">
                <p className="text-sm text-muted-foreground">סה״כ פריימים (משוער)</p>
                <p className="font-bold text-xl text-primary">
                  {videoInfo.frameCount.toLocaleString()}
                </p>
              </div>
            </div>
          </Card>
        )}

        {/* Settings */}
        {videoInfo && (
          <Card className="p-6 settings-card">
            <div className="flex items-center gap-2 mb-6">
              <Settings className="w-5 h-5 text-primary" />
              <h2 className="font-semibold text-lg">הגדרות חילוץ</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* FPS */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <Label>פריימים לשנייה (FPS)</Label>
                  <span className="text-sm font-mono bg-muted px-2 py-1 rounded">
                    {settings.fps} FPS
                  </span>
                </div>
                <Slider
                  value={[settings.fps]}
                  onValueChange={([value]) =>
                    setSettings((prev) => ({ ...prev, fps: value }))
                  }
                  min={1}
                  max={Math.min(30, videoInfo.frameRate)}
                  step={1}
                  className="settings-slider"
                />
                <p className="text-xs text-muted-foreground">
                  יחולצו כ-{estimatedFrames} פריימים
                </p>
              </div>

              {/* Resolution */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <Label>רזולוציה</Label>
                  <span className="text-sm font-mono bg-muted px-2 py-1 rounded">
                    {settings.resolution}%
                  </span>
                </div>
                <Slider
                  value={[settings.resolution]}
                  onValueChange={([value]) =>
                    setSettings((prev) => ({ ...prev, resolution: value }))
                  }
                  min={10}
                  max={100}
                  step={10}
                  className="settings-slider"
                />
                <p className="text-xs text-muted-foreground">
                  {Math.round(videoInfo.width * (settings.resolution / 100))}×
                  {Math.round(videoInfo.height * (settings.resolution / 100))}
                </p>
              </div>

              {/* Save Method */}
              <div className="space-y-3">
                <Label>שיטת שמירה</Label>
                <Select
                  value={saveMethod}
                  onValueChange={(value: "zip" | "folder") =>
                    setSaveMethod(value)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="zip">💾 קובץ ZIP (מומלץ לקבצים קטנים)</SelectItem>
                    <SelectItem value="folder">📁 שמירה ישירה לתיקייה (לווידאו גדולים)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {saveMethod === "zip" 
                    ? "כל הפריימים יארזו לקובץ ZIP אחד" 
                    : "הפריימים יישמרו ישירות לתיקייה שתבחר"}
                </p>
              </div>

              {/* Format */}
              <div className="space-y-3">
                <Label>פורמט תמונה</Label>
                <Select
                  value={settings.format}
                  onValueChange={(value: "png" | "jpeg" | "webp") =>
                    setSettings((prev) => ({ ...prev, format: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="png">PNG (איכות מקסימלית)</SelectItem>
                    <SelectItem value="jpeg">JPEG (קובץ קטן יותר)</SelectItem>
                    <SelectItem value="webp">WebP (מאוזן)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Quality */}
              {settings.format !== "png" && (
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <Label>איכות תמונה</Label>
                    <span className="text-sm font-mono bg-muted px-2 py-1 rounded">
                      {Math.round(settings.quality * 100)}%
                    </span>
                  </div>
                  <Slider
                    value={[settings.quality * 100]}
                    onValueChange={([value]) =>
                      setSettings((prev) => ({ ...prev, quality: value / 100 }))
                    }
                    min={10}
                    max={100}
                    step={5}
                    className="settings-slider"
                  />
                </div>
              )}
            </div>
          </Card>
        )}

        {/* Progress & Actions */}
        {videoInfo && (
          <Card className="p-6 action-card">
            <div className="space-y-6">
              {isExtracting && (
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">מחלץ פריימים...</span>
                      {extractionMethod && (
                        <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded-full">
                          {extractionMethod}
                        </span>
                      )}
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {Math.round(extractionProgress)}%
                    </span>
                  </div>
                  {statusMessage && (
                    <div className="text-center">
                      <p className="text-sm text-muted-foreground font-medium">
                        {statusMessage}
                      </p>
                    </div>
                  )}
                  <Progress value={extractionProgress} className="progress-bar" />
                </div>
              )}

              {extractedFrames.length > 0 && !isExtracting && !isCreatingOutput && (
                <div className="extracted-summary flex items-center gap-3 p-4 rounded-lg">
                  <ImageIcon className="w-8 h-8 text-success" />
                  <div>
                    <p className="font-medium">
                      חולצו {extractedFrames.length} פריימים בהצלחה!
                    </p>
                    <p className="text-sm text-muted-foreground">
                      מוכן להורדה כקובץ ZIP
                      {extractionMethod && ` • שיטה: ${extractionMethod}`}
                    </p>
                  </div>
                </div>
              )}

              {isCreatingOutput && (
                <div className="extracted-summary flex items-center gap-3 p-4 rounded-lg bg-blue-500/10">
                  <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
                  <div>
                    <p className="font-medium text-blue-600">
                      שומר קבצים...
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {statusMessage}
                    </p>
                  </div>
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-3">
                {isExtracting ? (
                  <Button
                    onClick={cancelExtraction}
                    disabled={isCancelling}
                    variant="destructive"
                    className="flex-1"
                    size="lg"
                  >
                    {isCancelling ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        מבטל...
                      </>
                    ) : (
                      <>
                        <X className="w-4 h-4 mr-2" />
                        בטל חילוץ
                      </>
                    )}
                  </Button>
                ) : (
                  <Button
                    onClick={extractFrames}
                    disabled={!videoFile}
                    className="extract-button flex-1"
                    size="lg"
                  >
                    <Film className="w-4 h-4 mr-2" />
                    {saveMethod === "zip" ? "התחל חילוץ" : "חלץ ושמור לתיקייה"}
                    {useWebCodecs && (
                      <Zap className="w-4 h-4 mr-1 text-primary" />
                    )}
                  </Button>
                )}

                {extractedFrames.length > 0 && !isExtracting && (
                  <Button
                    onClick={downloadAsZip}
                    variant="secondary"
                    className="download-button flex-1"
                    size="lg"
                  >
                    <Download className="w-4 h-4 mr-2" />
                    הורד ZIP ({extractedFrames.length} פריימים)
                  </Button>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* Hidden elements for processing */}
        <video
          ref={videoRef}
          src={videoUrl}
          className="hidden"
          playsInline
          muted
        />
        <canvas ref={canvasRef} className="hidden" />
      </div>
    </div>
  );
};

export default VideoFrameExtractor;import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Upload, Download, Film, Settings, Image as ImageIcon, Loader2, Zap, X } from "lucide-react";
import JSZip from "jszip";
import * as MP4Box from "mp4box";

interface VideoInfo {
  width: number;
  height: number;
  duration: number;
  frameCount: number;
  frameRate: number;
}

interface ExtractionSettings {
  fps: number;
  resolution: number;
  quality: number;
  format: "png" | "jpeg" | "webp";
}

// Using mp4box types directly - cast as needed

const VideoFrameExtractor = () => {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionProgress, setExtractionProgress] = useState(0);
  const [extractedFrames, setExtractedFrames] = useState<Blob[]>([]);
  const [useWebCodecs, setUseWebCodecs] = useState<boolean | null>(null);
  const [extractionMethod, setExtractionMethod] = useState<string>("");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [settings, setSettings] = useState<ExtractionSettings>({
    fps: 1,
    resolution: 100,
    quality: 0.9,
    format: "png",
  });
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [saveMethod, setSaveMethod] = useState<"zip" | "folder">("zip");
  const [isCreatingOutput, setIsCreatingOutput] = useState(false);

  // Check WebCodecs support
  const supportsWebCodecs = useCallback(() => {
    return 'VideoDecoder' in window && 'EncodedVideoChunk' in window;
  }, []);

  const getVideoFpsFromFile = async (file: File): Promise<{ fps: number; frameCount: number; codec?: string; trackId?: number } | null> => {
    return new Promise((resolve) => {
      const mp4boxFile = MP4Box.createFile();
      
      mp4boxFile.onReady = (info: MP4Box.Movie) => {
        const videoTrack = info.tracks.find((track: MP4Box.Track) => track.type === "video");
        if (videoTrack) {
          const fps = videoTrack.nb_samples / (videoTrack.duration / videoTrack.timescale);
          const frameCount = videoTrack.nb_samples;
          resolve({ 
            fps: Math.round(fps * 100) / 100, 
            frameCount,
            codec: videoTrack.codec,
            trackId: videoTrack.id
          });
        } else {
          resolve(null);
        }
      };

      mp4boxFile.onError = () => {
        resolve(null);
      };

      const reader = new FileReader();
      reader.onload = () => {
        const buffer = reader.result as ArrayBuffer;
        const mp4Buffer = buffer as MP4Box.MP4BoxBuffer;
        mp4Buffer.fileStart = 0;
        mp4boxFile.appendBuffer(mp4Buffer);
        mp4boxFile.flush();
      };
      reader.onerror = () => resolve(null);
      reader.readAsArrayBuffer(file);
    });
  };

  // WebCodecs-based fast extraction
  const extractFramesWebCodecs = async (
    file: File,
    videoInfo: VideoInfo,
    settings: ExtractionSettings,
    onProgress: (progress: number, currentFrame: number, totalFrames: number) => void,
    signal?: AbortSignal
  ): Promise<Blob[]> => {
    return new Promise((resolve, reject) => {
      // Check for cancellation at start
      if (signal?.aborted) {
        reject(new DOMException("Extraction cancelled", "AbortError"));
        return;
      }
      const frames: Blob[] = [];
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d")!;

      const outputWidth = Math.round(videoInfo.width * (settings.resolution / 100));
      const outputHeight = Math.round(videoInfo.height * (settings.resolution / 100));
      canvas.width = outputWidth;
      canvas.height = outputHeight;

      const frameIntervalMicroseconds = (1000000 / settings.fps);
      let lastExtractedTimestamp = -frameIntervalMicroseconds;
      const targetFrameCount = Math.floor(videoInfo.duration * settings.fps);
      let processedFrameCount = 0;
      
      const mimeType = `image/${settings.format}`;
      const quality = settings.format === "png" ? undefined : settings.quality;

      const pendingBlobs: Promise<void>[] = [];
      let decoderClosed = false;

      const mp4boxFile = MP4Box.createFile();
      let videoTrackId: number | null = null;
      let codecConfig: VideoDecoderConfig | null = null;

      let rejected = false;
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
          decoderClosed = true;
          decoder.close();
        } catch {
          // ignore
        }
        reject(err);
      };

      // Listen for abort signal
      const abortHandler = () => {
        fail(new DOMException("Extraction cancelled", "AbortError"));
      };
      signal?.addEventListener("abort", abortHandler, { once: true });

      const decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          const timestamp = frame.timestamp;
          
          // Check if we should keep this frame based on target FPS
          if (timestamp - lastExtractedTimestamp >= frameIntervalMicroseconds * 0.9) {
            lastExtractedTimestamp = timestamp;
            
            ctx.drawImage(frame, 0, 0, outputWidth, outputHeight);
            
            const blobPromise = new Promise<void>((resolveBlob) => {
              canvas.toBlob(
                (blob) => {
                  if (blob) {
                    frames.push(blob);
                    processedFrameCount++;
                    onProgress((processedFrameCount / targetFrameCount) * 100, processedFrameCount, targetFrameCount);
                  }
                  resolveBlob();
                },
                mimeType,
                quality
              );
            });
            pendingBlobs.push(blobPromise);
          }
          
          frame.close();
        },
        error: (e) => {
          console.error("Decoder error:", e);
          if (!decoderClosed) {
            fail(e);
          }
        },
      });

      let trackTimescale = 1;
      
      mp4boxFile.onReady = (info: MP4Box.Movie) => {
        const videoTrack = info.tracks.find((track: MP4Box.Track) => track.type === "video");
        if (!videoTrack) {
          reject(new Error("No video track found"));
          return;
        }

        videoTrackId = videoTrack.id;
        trackTimescale = videoTrack.timescale;
        
        // Build codec string for WebCodecs
        const codecString = videoTrack.codec;
        
        // Extract description (avcC/hvcC) for H.264/HEVC codecs
        let description: Uint8Array | undefined;

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
          // This usually writes a full MP4 box (size+type+payload), so we strip the 8-byte header.
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
        
        try {
          // Get the track box to access codec-specific configuration
          const trak = mp4boxFile.getTrackById(videoTrackId);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const entry = (trak as any)?.mdia?.minf?.stbl?.stsd?.entries?.[0];
          
          if (entry) {
            // For H.264 (AVC) - avcC box contains SPS/PPS
            if (entry.avcC) {
              description = serializeMp4Box(entry.avcC);
            }
            // For HEVC - hvcC box
            else if (entry.hvcC) {
              description = serializeMp4Box(entry.hvcC);
            }
          }
        } catch (e) {
          console.warn("Could not extract codec description:", e);
        }
        
        // For AVC codecs, description is required
        if (codecString.startsWith("avc") && !description) {
          console.warn("No AVC description found, falling back to legacy method");
          fail(new Error("AVC description required for WebCodecs"));
          return;
        }
        
        codecConfig = {
          codec: codecString,
          codedWidth: (videoTrack as { video?: { width: number; height: number } }).video?.width || videoInfo.width,
          codedHeight: (videoTrack as { video?: { width: number; height: number } }).video?.height || videoInfo.height,
          hardwareAcceleration: "prefer-hardware" as HardwareAcceleration,
          description: description,
        };

        try {
          decoder.configure(codecConfig);
          mp4boxFile.setExtractionOptions(videoTrackId, null, { nbSamples: 100 });
          mp4boxFile.start();
        } catch (e) {
          fail(e);
        }
      };

      mp4boxFile.onSamples = (_trackId: number, _user: unknown, samples: MP4Box.Sample[]) => {
        for (const sample of samples) {
          try {
            // Convert from track timescale to microseconds
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
            // If WebCodecs decoding fails (common with missing/invalid description or keyframe requirements),
            // stop this path so the caller can fall back to the legacy extractor.
            fail(e);
            return;
          }
        }
      };

      mp4boxFile.onError = (_module: string, message: string) => {
        console.error("MP4Box error:", message);
        fail(new Error(message));
      };

      // Read file in chunks for better performance
      const chunkSize = 1024 * 1024; // 1MB chunks
      let offset = 0;

      const readNextChunk = () => {
        if (offset >= file.size) {
          mp4boxFile.flush();
          
          // Wait for decoder to finish
          decoder.flush().then(async () => {
            decoderClosed = true;
            decoder.close();
            signal?.removeEventListener("abort", abortHandler);
            await Promise.all(pendingBlobs);
            resolve(frames);
          }).catch((e) => {
            signal?.removeEventListener("abort", abortHandler);
            reject(e);
          });
          return;
        }

        const slice = file.slice(offset, offset + chunkSize);
        const reader = new FileReader();
        
        reader.onload = () => {
          const buffer = reader.result as ArrayBuffer;
          const mp4Buffer = buffer as MP4Box.MP4BoxBuffer;
          mp4Buffer.fileStart = offset;
          mp4boxFile.appendBuffer(mp4Buffer);
          offset += chunkSize;
          readNextChunk();
        };
        
        reader.onerror = () => reject(new Error("Failed to read file"));
        reader.readAsArrayBuffer(slice);
      };

      readNextChunk();
    });
  };

  // Fallback: Legacy seek-based extraction
  const extractFramesLegacy = async (
    videoInfo: VideoInfo,
    settings: ExtractionSettings,
    onProgress: (progress: number, currentFrame: number, totalFrames: number) => void,
    signal?: AbortSignal
  ): Promise<Blob[]> => {
    const video = videoRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    const outputWidth = Math.round(videoInfo.width * (settings.resolution / 100));
    const outputHeight = Math.round(videoInfo.height * (settings.resolution / 100));
    canvas.width = outputWidth;
    canvas.height = outputHeight;

    const framesToExtract = Math.floor(videoInfo.duration * settings.fps);
    const frameInterval = 1 / settings.fps;
    const frames: Blob[] = [];

    video.currentTime = 0;

    for (let i = 0; i < framesToExtract; i++) {
      // Check for cancellation
      if (signal?.aborted) {
        throw new DOMException("Extraction cancelled", "AbortError");
      }

      const targetTime = i * frameInterval;
      
      await new Promise<void>((resolve) => {
        video.currentTime = targetTime;
        video.onseeked = () => resolve();
      });

      ctx.drawImage(video, 0, 0, outputWidth, outputHeight);

      const mimeType = `image/${settings.format}`;
      const quality = settings.format === "png" ? undefined : settings.quality;

      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob(
          (blob) => resolve(blob!),
          mimeType,
          quality
        );
      });

      frames.push(blob);
      onProgress(((i + 1) / framesToExtract) * 100, i + 1, framesToExtract);
    }

    return frames;
  };

  const analyzeVideo = useCallback(async (file: File) => {
    setIsAnalyzing(true);
    const url = URL.createObjectURL(file);
    setVideoUrl(url);

    // Check WebCodecs support
    const webCodecsSupported = supportsWebCodecs();
    setUseWebCodecs(webCodecsSupported);

    // Try to get FPS from MP4Box first
    const mp4Info = await getVideoFpsFromFile(file);

    return new Promise<VideoInfo>((resolve) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.src = url;

      video.onloadedmetadata = () => {
        const duration = video.duration;
        const width = video.videoWidth;
        const height = video.videoHeight;
        
        const detectedFps = mp4Info?.fps || 30;
        const frameCount = mp4Info?.frameCount || Math.floor(duration * detectedFps);

        const info: VideoInfo = {
          width,
          height,
          duration,
          frameCount,
          frameRate: detectedFps,
        };

        setVideoInfo(info);
        setSettings((prev) => ({
          ...prev,
          fps: Math.min(prev.fps, Math.floor(detectedFps)),
        }));
        setIsAnalyzing(false);
        resolve(info);
      };
    });
  }, [supportsWebCodecs]);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && file.type.startsWith("video/")) {
      setVideoFile(file);
      setExtractedFrames([]);
      setExtractionProgress(0);
      setExtractionMethod("");
      setStatusMessage("");
      await analyzeVideo(file);
    }
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file && file.type.startsWith("video/")) {
      setVideoFile(file);
      setExtractedFrames([]);
      setExtractionProgress(0);
      setExtractionMethod("");
      setStatusMessage("");
      await analyzeVideo(file);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const extractFrames = async () => {
    if (!videoFile || !videoInfo) return;

    setIsExtracting(true);
    setIsCancelling(false);
    setExtractedFrames([]);
    setExtractionProgress(0);
    setStatusMessage("קורא את הקובץ...");

    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    const onProgress = (progress: number, currentFrame: number, totalFrames: number) => {
      setExtractionProgress(Math.min(progress, 100));
      setStatusMessage(`חולצו ${currentFrame.toLocaleString()} מתוך ${totalFrames.toLocaleString()} פריימים`);
    };

    try {
      let frames: Blob[];
      
      // Try WebCodecs first for MP4 files
      const isMp4 = videoFile.type === "video/mp4" || videoFile.name.toLowerCase().endsWith(".mp4");
      
      if (useWebCodecs && isMp4) {
        setExtractionMethod("WebCodecs (GPU מואץ)");
        try {
          frames = await extractFramesWebCodecs(videoFile, videoInfo, settings, onProgress, signal);
        } catch (e) {
          if (signal.aborted) throw e;
          console.warn("WebCodecs extraction failed, falling back to legacy:", e);
          setExtractionMethod("Legacy (CPU)");
          setStatusMessage("קורא את הקובץ...");
          frames = await extractFramesLegacy(videoInfo, settings, onProgress, signal);
        }
      } else {
        setExtractionMethod("Legacy (CPU)");
        frames = await extractFramesLegacy(videoInfo, settings, onProgress, signal);
      }

      if (!signal.aborted) {
        if (saveMethod === "zip") {
          setStatusMessage("יוצר קובץ ZIP...");
          setExtractedFrames(frames);
          
          // Small delay to show the "creating ZIP" message
          await new Promise(resolve => setTimeout(resolve, 300));
          setStatusMessage("הושלם בהצלחה!");
        } else {
          // For folder save, save directly
          setIsCreatingOutput(true);
          setStatusMessage("שומר קבצים לתיקייה...");
          await saveFramesToFolder(frames);
          setStatusMessage("הקבצים נשמרו בהצלחה!");
          setIsCreatingOutput(false);
          // Clear frames to save memory since they're already saved
          setExtractedFrames([]);
        }
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        console.log("Extraction cancelled by user");
        setStatusMessage("החילוץ בוטל");
      } else {
        console.error("Extraction failed:", e);
        setStatusMessage("שגיאה בחילוץ");
      }
    } finally {
      setIsExtracting(false);
      setIsCancelling(false);
      setIsCreatingOutput(false);
      abortControllerRef.current = null;
    }
  };

  const cancelExtraction = () => {
    if (abortControllerRef.current) {
      setIsCancelling(true);
      setStatusMessage("מבטל...");
      abortControllerRef.current.abort();
    }
  };

  const downloadAsZip = async () => {
    if (extractedFrames.length === 0) return;

    setStatusMessage("יוצר קובץ ZIP להורדה...");

    const zip = new JSZip();
    const folder = zip.folder("frames");

    extractedFrames.forEach((blob, index) => {
      const paddedIndex = String(index + 1).padStart(5, "0");
      folder?.file(`frame_${paddedIndex}.${settings.format}`, blob);
    });

    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    const a = document.createElement("a");
    a.href = url;
    a.download = `frames_${videoFile?.name.split(".")[0] || "video"}.zip`;
    a.click();
    URL.revokeObjectURL(url);

    setStatusMessage("הושלם בהצלחה!");
  };

  const saveFramesToFolder = async (frames: Blob[]) => {
    try {
      // Check if File System Access API is supported
      if (!('showDirectoryPicker' in window)) {
        alert("הדפדפן שלך לא תומך בשמירה ישירה לתיקייה. אנא השתמש באפשרות ZIP.");
        return;
      }

      // Request directory access
      const dirHandle = await (window as Window & { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker();
      
      // Create a subdirectory for frames
      const framesFolderName = `frames_${videoFile?.name.split(".")[0] || "video"}`;
      const framesDir = await dirHandle.getDirectoryHandle(framesFolderName, { create: true });

      // Save each frame
      for (let i = 0; i < frames.length; i++) {
        const paddedIndex = String(i + 1).padStart(5, "0");
        const fileName = `frame_${paddedIndex}.${settings.format}`;
        
        const fileHandle = await framesDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(frames[i]);
        await writable.close();

        // Update progress
        const progress = ((i + 1) / frames.length) * 100;
        setExtractionProgress(progress);
        setStatusMessage(`נשמר ${i + 1} מתוך ${frames.length} קבצים לתיקייה`);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        console.log("User cancelled folder selection");
        setStatusMessage("בחירת התיקייה בוטלה");
      } else {
        console.error("Error saving to folder:", err);
        alert("שגיאה בשמירת הקבצים לתיקייה");
        setStatusMessage("שגיאה בשמירה");
      }
      throw err;
    }
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const estimatedFrames = videoInfo
    ? Math.floor(videoInfo.duration * settings.fps)
    : 0;

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl md:text-4xl font-bold text-foreground">
            מחלץ פריימים מווידאו
          </h1>
          <p className="text-muted-foreground">
            העלה וידאו, בחר הגדרות והורד את כל הפריימים כקובץ ZIP
          </p>
          {useWebCodecs !== null && (
            <div className={`inline-flex items-center gap-2 px-3 py-1 rounded-full text-sm ${
              useWebCodecs 
                ? "bg-green-500/10 text-green-600 dark:text-green-400" 
                : "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400"
            }`}>
              <Zap className="w-4 h-4" />
              {useWebCodecs 
                ? "WebCodecs זמין - חילוץ מהיר עם GPU" 
                : "WebCodecs לא נתמך - שימוש בשיטה רגילה"}
            </div>
          )}
        </div>

        {/* Upload Zone */}
        <Card
          className={`upload-zone p-8 border-2 border-dashed transition-all cursor-pointer ${
            videoFile ? "border-primary/50 bg-primary/5" : "border-border hover:border-primary/30"
          }`}
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            onChange={handleFileSelect}
            className="hidden"
          />
          <div className="flex flex-col items-center justify-center gap-4">
            {isAnalyzing ? (
              <>
                <Loader2 className="w-12 h-12 text-primary animate-spin" />
                <p className="text-muted-foreground">מנתח את הווידאו...</p>
              </>
            ) : videoFile ? (
              <>
                <Film className="w-12 h-12 text-primary" />
                <div className="text-center">
                  <p className="font-medium text-foreground">{videoFile.name}</p>
                  <p className="text-sm text-muted-foreground">
                    לחץ להחלפת קובץ
                  </p>
                </div>
              </>
            ) : (
              <>
                <Upload className="w-12 h-12 text-muted-foreground" />
                <div className="text-center">
                  <p className="font-medium text-foreground">
                    גרור ושחרר וידאו כאן
                  </p>
                  <p className="text-sm text-muted-foreground">
                    או לחץ לבחירת קובץ
                  </p>
                </div>
              </>
            )}
          </div>
        </Card>

        {/* Video Info */}
        {videoInfo && (
          <Card className="p-6 video-info-card">
            <div className="flex items-center gap-2 mb-4">
              <Film className="w-5 h-5 text-primary" />
              <h2 className="font-semibold text-lg">מידע על הווידאו</h2>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="info-stat">
                <p className="text-sm text-muted-foreground">רזולוציה</p>
                <p className="font-bold text-xl">
                  {videoInfo.width}×{videoInfo.height}
                </p>
              </div>
              <div className="info-stat">
                <p className="text-sm text-muted-foreground">משך</p>
                <p className="font-bold text-xl">
                  {formatDuration(videoInfo.duration)}
                </p>
              </div>
              <div className="info-stat">
                <p className="text-sm text-muted-foreground">קצב פריימים</p>
                <p className="font-bold text-xl">{videoInfo.frameRate} FPS</p>
              </div>
              <div className="info-stat">
                <p className="text-sm text-muted-foreground">סה״כ פריימים (משוער)</p>
                <p className="font-bold text-xl text-primary">
                  {videoInfo.frameCount.toLocaleString()}
                </p>
              </div>
            </div>
          </Card>
        )}

        {/* Settings */}
        {videoInfo && (
          <Card className="p-6 settings-card">
            <div className="flex items-center gap-2 mb-6">
              <Settings className="w-5 h-5 text-primary" />
              <h2 className="font-semibold text-lg">הגדרות חילוץ</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* FPS */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <Label>פריימים לשנייה (FPS)</Label>
                  <span className="text-sm font-mono bg-muted px-2 py-1 rounded">
                    {settings.fps} FPS
                  </span>
                </div>
                <Slider
                  value={[settings.fps]}
                  onValueChange={([value]) =>
                    setSettings((prev) => ({ ...prev, fps: value }))
                  }
                  min={1}
                  max={Math.min(30, videoInfo.frameRate)}
                  step={1}
                  className="settings-slider"
                />
                <p className="text-xs text-muted-foreground">
                  יחולצו כ-{estimatedFrames} פריימים
                </p>
              </div>

              {/* Resolution */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <Label>רזולוציה</Label>
                  <span className="text-sm font-mono bg-muted px-2 py-1 rounded">
                    {settings.resolution}%
                  </span>
                </div>
                <Slider
                  value={[settings.resolution]}
                  onValueChange={([value]) =>
                    setSettings((prev) => ({ ...prev, resolution: value }))
                  }
                  min={10}
                  max={100}
                  step={10}
                  className="settings-slider"
                />
                <p className="text-xs text-muted-foreground">
                  {Math.round(videoInfo.width * (settings.resolution / 100))}×
                  {Math.round(videoInfo.height * (settings.resolution / 100))}
                </p>
              </div>

              {/* Save Method */}
              <div className="space-y-3">
                <Label>שיטת שמירה</Label>
                <Select
                  value={saveMethod}
                  onValueChange={(value: "zip" | "folder") =>
                    setSaveMethod(value)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="zip">💾 קובץ ZIP (מומלץ לקבצים קטנים)</SelectItem>
                    <SelectItem value="folder">📁 שמירה ישירה לתיקייה (לווידאו גדולים)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {saveMethod === "zip" 
                    ? "כל הפריימים יארזו לקובץ ZIP אחד" 
                    : "הפריימים יישמרו ישירות לתיקייה שתבחר"}
                </p>
              </div>

              {/* Format */}
              <div className="space-y-3">
                <Label>פורמט תמונה</Label>
                <Select
                  value={settings.format}
                  onValueChange={(value: "png" | "jpeg" | "webp") =>
                    setSettings((prev) => ({ ...prev, format: value }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="png">PNG (איכות מקסימלית)</SelectItem>
                    <SelectItem value="jpeg">JPEG (קובץ קטן יותר)</SelectItem>
                    <SelectItem value="webp">WebP (מאוזן)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Quality */}
              {settings.format !== "png" && (
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <Label>איכות תמונה</Label>
                    <span className="text-sm font-mono bg-muted px-2 py-1 rounded">
                      {Math.round(settings.quality * 100)}%
                    </span>
                  </div>
                  <Slider
                    value={[settings.quality * 100]}
                    onValueChange={([value]) =>
                      setSettings((prev) => ({ ...prev, quality: value / 100 }))
                    }
                    min={10}
                    max={100}
                    step={5}
                    className="settings-slider"
                  />
                </div>
              )}
            </div>
          </Card>
        )}

        {/* Progress & Actions */}
        {videoInfo && (
          <Card className="p-6 action-card">
            <div className="space-y-6">
              {isExtracting && (
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">מחלץ פריימים...</span>
                      {extractionMethod && (
                        <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded-full">
                          {extractionMethod}
                        </span>
                      )}
                    </div>
                    <span className="text-sm text-muted-foreground">
                      {Math.round(extractionProgress)}%
                    </span>
                  </div>
                  {statusMessage && (
                    <div className="text-center">
                      <p className="text-sm text-muted-foreground font-medium">
                        {statusMessage}
                      </p>
                    </div>
                  )}
                  <Progress value={extractionProgress} className="progress-bar" />
                </div>
              )}

              {extractedFrames.length > 0 && !isExtracting && !isCreatingOutput && (
                <div className="extracted-summary flex items-center gap-3 p-4 rounded-lg">
                  <ImageIcon className="w-8 h-8 text-success" />
                  <div>
                    <p className="font-medium">
                      חולצו {extractedFrames.length} פריימים בהצלחה!
                    </p>
                    <p className="text-sm text-muted-foreground">
                      מוכן להורדה כקובץ ZIP
                      {extractionMethod && ` • שיטה: ${extractionMethod}`}
                    </p>
                  </div>
                </div>
              )}

              {isCreatingOutput && (
                <div className="extracted-summary flex items-center gap-3 p-4 rounded-lg bg-blue-500/10">
                  <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
                  <div>
                    <p className="font-medium text-blue-600">
                      שומר קבצים...
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {statusMessage}
                    </p>
                  </div>
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-3">
                {isExtracting ? (
                  <Button
                    onClick={cancelExtraction}
                    disabled={isCancelling}
                    variant="destructive"
                    className="flex-1"
                    size="lg"
                  >
                    {isCancelling ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        מבטל...
                      </>
                    ) : (
                      <>
                        <X className="w-4 h-4 mr-2" />
                        בטל חילוץ
                      </>
                    )}
                  </Button>
                ) : (
                  <Button
                    onClick={extractFrames}
                    disabled={!videoFile}
                    className="extract-button flex-1"
                    size="lg"
                  >
                    <Film className="w-4 h-4 mr-2" />
                    {saveMethod === "zip" ? "התחל חילוץ" : "חלץ ושמור לתיקייה"}
                    {useWebCodecs && (
                      <Zap className="w-4 h-4 mr-1 text-primary" />
                    )}
                  </Button>
                )}

                {extractedFrames.length > 0 && !isExtracting && (
                  <Button
                    onClick={downloadAsZip}
                    variant="secondary"
                    className="download-button flex-1"
                    size="lg"
                  >
                    <Download className="w-4 h-4 mr-2" />
                    הורד ZIP ({extractedFrames.length} פריימים)
                  </Button>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* Hidden elements for processing */}
        <video
          ref={videoRef}
          src={videoUrl}
          className="hidden"
          playsInline
          muted
        />
        <canvas ref={canvasRef} className="hidden" />
      </div>
    </div>
  );
};

export default VideoFrameExtractor;
