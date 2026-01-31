import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import {
  Upload,
  Download,
  Film,
  Settings,
  Image as ImageIcon,
  Loader2,
  Zap,
  AlertCircle,
  CheckCircle2,
  X,
} from "lucide-react";
import JSZip from "jszip";

// ============================================================================
// Types & Interfaces
// ============================================================================

interface VideoInfo {
  width: number;
  height: number;
  duration: number;
  frameCount: number;
  frameRate: number;
  codec?: string;
}

interface ExtractionSettings {
  fps: number;
  resolution: number;
  quality: number;
  format: "png" | "jpeg" | "webp";
}

interface MP4BoxFile {
  onReady?: (info: any) => void;
  onError?: (e: any) => void;
  onSamples?: (id: number, user: any, samples: any[]) => void;
  appendBuffer: (data: ArrayBuffer) => number;
  setExtractionOptions: (id: number, user: any, options: any) => void;
  start: () => void;
  flush: () => void;
  stop: () => void;
}

declare global {
  interface Window {
    MP4Box: {
      createFile: () => MP4BoxFile;
    };
  }
}

// ============================================================================
// Main Component
// ============================================================================

const VideoFrameExtractor = () => {
  // State
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionProgress, setExtractionProgress] = useState(0);
  const [extractedFrames, setExtractedFrames] = useState<Blob[]>([]);
  const [useWebCodecs, setUseWebCodecs] = useState<boolean | null>(null);
  const [extractionMethod, setExtractionMethod] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isMP4BoxLoaded, setIsMP4BoxLoaded] = useState(false);

  const [settings, setSettings] = useState<ExtractionSettings>({
    fps: 1,
    resolution: 100,
    quality: 0.9,
    format: "png",
  });

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // ============================================================================
  // Load MP4Box Library
  // ============================================================================

  useEffect(() => {
    const loadMP4Box = async () => {
      if (typeof window !== "undefined" && !window.MP4Box) {
        try {
          const script = document.createElement("script");
          script.src =
            "https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js";
          script.async = true;
          script.onload = () => {
            setIsMP4BoxLoaded(true);
          };
          script.onerror = () => {
            console.error("Failed to load MP4Box");
            setIsMP4BoxLoaded(false);
          };
          document.head.appendChild(script);
        } catch (e) {
          console.error("Error loading MP4Box:", e);
          setIsMP4BoxLoaded(false);
        }
      } else if (window.MP4Box) {
        setIsMP4BoxLoaded(true);
      }
    };

    loadMP4Box();

    // Check WebCodecs support
    const webCodecsSupported =
      typeof window !== "undefined" &&
      "VideoDecoder" in window &&
      "VideoEncoder" in window &&
      "VideoFrame" in window;
    setUseWebCodecs(webCodecsSupported);
  }, []);

  // ============================================================================
  // Video Analysis with MP4Box
  // ============================================================================

  const analyzeVideoWithMP4Box = useCallback(
    async (file: File): Promise<VideoInfo | null> => {
      if (!isMP4BoxLoaded || !window.MP4Box) {
        return null;
      }

      return new Promise((resolve) => {
        const mp4boxFile = window.MP4Box.createFile();

        mp4boxFile.onReady = (info: any) => {
          const videoTrack = info.tracks.find((t: any) => t.type === "video");

          if (videoTrack) {
            const fps = videoTrack.timescale / videoTrack.sample_duration || 30;
            const frameCount = videoTrack.nb_samples;
            const duration = info.duration / info.timescale;
            const width = videoTrack.track_width;
            const height = videoTrack.track_height;
            const codec = videoTrack.codec;

            resolve({
              width,
              height,
              duration,
              frameCount,
              frameRate: Math.round(fps * 100) / 100,
              codec,
            });
          } else {
            resolve(null);
          }
        };

        mp4boxFile.onError = (e: any) => {
          console.error("MP4Box error:", e);
          resolve(null);
        };

        const reader = new FileReader();
        reader.onload = (e) => {
          const arrayBuffer = e.target?.result as ArrayBuffer;
          (arrayBuffer as any).fileStart = 0;
          mp4boxFile.appendBuffer(arrayBuffer);
          mp4boxFile.flush();
        };
        reader.readAsArrayBuffer(file);
      });
    },
    [isMP4BoxLoaded]
  );

  // ============================================================================
  // Video Analysis (Fallback)
  // ============================================================================

  const analyzeVideo = useCallback(
    async (file: File): Promise<VideoInfo> => {
      setIsAnalyzing(true);
      setError(null);

      const url = URL.createObjectURL(file);
      setVideoUrl(url);

      // Try MP4Box first for MP4 files
      const isMp4 =
        file.type === "video/mp4" || file.name.toLowerCase().endsWith(".mp4");

      if (isMp4 && isMP4BoxLoaded) {
        const mp4Info = await analyzeVideoWithMP4Box(file);
        if (mp4Info) {
          setVideoInfo(mp4Info);
          setSettings((prev) => ({
            ...prev,
            fps: Math.min(prev.fps, Math.floor(mp4Info.frameRate)),
          }));
          setIsAnalyzing(false);
          return mp4Info;
        }
      }

      // Fallback to HTML5 video element
      return new Promise((resolve, reject) => {
        const video = document.createElement("video");
        video.preload = "metadata";
        video.src = url;

        video.onloadedmetadata = () => {
          const duration = video.duration;
          const width = video.videoWidth;
          const height = video.videoHeight;
          const detectedFps = 30; // Default FPS for non-MP4

          const info: VideoInfo = {
            width,
            height,
            duration,
            frameCount: Math.floor(duration * detectedFps),
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

        video.onerror = () => {
          setError("שגיאה בטעינת הווידאו");
          setIsAnalyzing(false);
          reject(new Error("Failed to load video"));
        };
      });
    },
    [isMP4BoxLoaded, analyzeVideoWithMP4Box]
  );

  // ============================================================================
  // WebCodecs Extraction (Fast Method)
  // ============================================================================

  const extractFramesWebCodecs = useCallback(
    async (
      file: File,
      videoInfo: VideoInfo,
      settings: ExtractionSettings,
      onProgress: (progress: number) => void
    ): Promise<Blob[]> => {
      return new Promise((resolve, reject) => {
        if (!window.MP4Box) {
          reject(new Error("MP4Box not loaded"));
          return;
        }

        const frames: Blob[] = [];
        const canvas = canvasRef.current!;
        const ctx = canvas.getContext("2d")!;

        const outputWidth = Math.round(
          videoInfo.width * (settings.resolution / 100)
        );
        const outputHeight = Math.round(
          videoInfo.height * (settings.resolution / 100)
        );

        canvas.width = outputWidth;
        canvas.height = outputHeight;

        const frameInterval = 1 / settings.fps;
        const frameIntervalMicroseconds = frameInterval * 1000000;
        const targetFrameCount = Math.floor(videoInfo.duration * settings.fps);

        let lastExtractedTimestamp = -frameIntervalMicroseconds;
        let processedFrameCount = 0;
        let decoderClosed = false;

        const mimeType = `image/${settings.format}`;
        const quality = settings.format === "png" ? undefined : settings.quality;

        const pendingBlobs: Promise<void>[] = [];

        const decoder = new VideoDecoder({
          output: (frame: VideoFrame) => {
            try {
              const timestamp = frame.timestamp;

              // Check if we should extract this frame based on target FPS
              if (
                timestamp - lastExtractedTimestamp >=
                frameIntervalMicroseconds * 0.95
              ) {
                lastExtractedTimestamp = timestamp;

                // Draw frame to canvas
                ctx.drawImage(frame, 0, 0, outputWidth, outputHeight);

                // Convert to blob
                const blobPromise = new Promise<void>((resolveBlob) => {
                  canvas.toBlob(
                    (blob) => {
                      if (blob) {
                        frames.push(blob);
                        processedFrameCount++;
                        onProgress(
                          Math.min(
                            (processedFrameCount / targetFrameCount) * 100,
                            100
                          )
                        );
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
            } catch (e) {
              console.error("Error processing frame:", e);
              frame.close();
            }
          },
          error: (e) => {
            console.error("Decoder error:", e);
            if (!decoderClosed) {
              decoderClosed = true;
              decoder.close();
              reject(e);
            }
          },
        });

        const mp4boxFile = window.MP4Box.createFile();
        let videoTrackId: number | null = null;

        mp4boxFile.onReady = (info: any) => {
          const videoTrack = info.tracks.find((t: any) => t.type === "video");

          if (!videoTrack) {
            reject(new Error("No video track found"));
            return;
          }

          videoTrackId = videoTrack.id;

          // Configure decoder
          const config: VideoDecoderConfig = {
            codec: videoTrack.codec.startsWith("avc1")
              ? "avc1.42E01E"
              : videoTrack.codec,
            codedWidth: videoTrack.track_width,
            codedHeight: videoTrack.track_height,
            hardwareAcceleration: "prefer-hardware",
          };

          try {
            decoder.configure(config);
            mp4boxFile.setExtractionOptions(videoTrackId, null, {
              nbSamples: 100,
            });
            mp4boxFile.start();
          } catch (e) {
            reject(e);
          }
        };

        mp4boxFile.onSamples = (
          trackId: number,
          user: any,
          samples: any[]
        ) => {
          for (const sample of samples) {
            try {
              const type = sample.is_sync ? "key" : "delta";
              const timestamp = (sample.cts / videoInfo.frameRate) * 1000000;
              const duration = (sample.duration / videoInfo.frameRate) * 1000000;

              const chunk = new EncodedVideoChunk({
                type,
                timestamp,
                duration,
                data: sample.data,
              });

              decoder.decode(chunk);
            } catch (e) {
              console.error("Error creating chunk:", e);
            }
          }
        };

        mp4boxFile.onError = (e: any) => {
          console.error("MP4Box error:", e);
          if (!decoderClosed) {
            decoderClosed = true;
            decoder.close();
            reject(new Error("MP4Box parsing failed"));
          }
        };

        // Read file in chunks
        const chunkSize = 1024 * 1024; // 1MB
        let offset = 0;

        const readNextChunk = () => {
          if (abortControllerRef.current?.signal.aborted) {
            decoderClosed = true;
            decoder.close();
            reject(new Error("Extraction cancelled"));
            return;
          }

          if (offset >= file.size) {
            mp4boxFile.flush();

            // Wait for decoder to finish
            decoder
              .flush()
              .then(async () => {
                decoderClosed = true;
                decoder.close();
                await Promise.all(pendingBlobs);
                resolve(frames);
              })
              .catch(reject);
            return;
          }

          const slice = file.slice(offset, offset + chunkSize);
          const reader = new FileReader();

          reader.onload = () => {
            const arrayBuffer = reader.result as ArrayBuffer;
            (arrayBuffer as any).fileStart = offset;
            mp4boxFile.appendBuffer(arrayBuffer);
            offset += chunkSize;
            setTimeout(readNextChunk, 0);
          };

          reader.onerror = () => {
            reject(new Error("Failed to read file"));
          };

          reader.readAsArrayBuffer(slice);
        };

        readNextChunk();
      });
    },
    []
  );

  // ============================================================================
  // Legacy Extraction (Fallback Method)
  // ============================================================================

  const extractFramesLegacy = useCallback(
    async (
      videoInfo: VideoInfo,
      settings: ExtractionSettings,
      onProgress: (progress: number) => void
    ): Promise<Blob[]> => {
      const video = videoRef.current;
      const canvas = canvasRef.current;

      if (!video || !canvas) {
        throw new Error("Video or canvas element not available");
      }

      const ctx = canvas.getContext("2d", {
        willReadFrequently: false,
        alpha: false,
      });

      if (!ctx) {
        throw new Error("Could not get canvas context");
      }

      const outputWidth = Math.round(
        videoInfo.width * (settings.resolution / 100)
      );
      const outputHeight = Math.round(
        videoInfo.height * (settings.resolution / 100)
      );

      canvas.width = outputWidth;
      canvas.height = outputHeight;

      const framesToExtract = Math.floor(videoInfo.duration * settings.fps);
      const frameInterval = 1 / settings.fps;
      const frames: Blob[] = [];

      video.currentTime = 0;
      await new Promise((resolve) => setTimeout(resolve, 100));

      for (let i = 0; i < framesToExtract; i++) {
        if (abortControllerRef.current?.signal.aborted) {
          throw new Error("Extraction cancelled");
        }

        const targetTime = i * frameInterval;

        // Seek to target time
        await new Promise<void>((resolve) => {
          const seekHandler = () => {
            video.removeEventListener("seeked", seekHandler);
            resolve();
          };
          video.addEventListener("seeked", seekHandler);
          video.currentTime = targetTime;
        });

        // Small delay to ensure frame is rendered
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Draw current frame
        ctx.drawImage(video, 0, 0, outputWidth, outputHeight);

        // Convert to blob
        const mimeType = `image/${settings.format}`;
        const quality = settings.format === "png" ? undefined : settings.quality;

        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (blob) => {
              if (blob) {
                resolve(blob);
              } else {
                reject(new Error("Failed to create blob"));
              }
            },
            mimeType,
            quality
          );
        });

        frames.push(blob);
        onProgress(((i + 1) / framesToExtract) * 100);
      }

      return frames;
    },
    []
  );

  // ============================================================================
  // Main Extraction Logic
  // ============================================================================

  const extractFrames = async () => {
    if (!videoFile || !videoInfo) return;

    setIsExtracting(true);
    setExtractedFrames([]);
    setExtractionProgress(0);
    setError(null);

    abortControllerRef.current = new AbortController();

    const onProgress = (progress: number) => {
      setExtractionProgress(Math.min(progress, 100));
    };

    try {
      let frames: Blob[];

      // Check if we can use WebCodecs
      const isMp4 =
        videoFile.type === "video/mp4" ||
        videoFile.name.toLowerCase().endsWith(".mp4");
      const canUseWebCodecs = useWebCodecs && isMp4 && isMP4BoxLoaded;

      if (canUseWebCodecs) {
        setExtractionMethod("WebCodecs (GPU מואץ)");
        try {
          frames = await extractFramesWebCodecs(
            videoFile,
            videoInfo,
            settings,
            onProgress
          );
        } catch (e) {
          console.warn("WebCodecs failed, falling back to legacy:", e);
          setExtractionMethod("Legacy (CPU)");
          frames = await extractFramesLegacy(videoInfo, settings, onProgress);
        }
      } else {
        setExtractionMethod("Legacy (CPU)");
        frames = await extractFramesLegacy(videoInfo, settings, onProgress);
      }

      setExtractedFrames(frames);
      setExtractionProgress(100);
    } catch (e: any) {
      console.error("Extraction failed:", e);
      if (e.message !== "Extraction cancelled") {
        setError("שגיאה בחילוץ הפריימים: " + e.message);
      }
    } finally {
      setIsExtracting(false);
    }
  };

  // ============================================================================
  // File Handling
  // ============================================================================

  const handleFileSelect = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (file && file.type.startsWith("video/")) {
      setVideoFile(file);
      setExtractedFrames([]);
      setExtractionProgress(0);
      setExtractionMethod("");
      setError(null);
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
      setError(null);
      await analyzeVideo(file);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const cancelExtraction = () => {
    abortControllerRef.current?.abort();
    setIsExtracting(false);
  };

  // ============================================================================
  // Download
  // ============================================================================

  const downloadAsZip = async () => {
    if (extractedFrames.length === 0) return;

    const zip = new JSZip();
    const folder = zip.folder("frames");

    if (!folder) return;

    extractedFrames.forEach((blob, index) => {
      const paddedIndex = String(index + 1).padStart(5, "0");
      folder.file(`frame_${paddedIndex}.${settings.format}`, blob);
    });

    const content = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });

    const url = URL.createObjectURL(content);
    const a = document.createElement("a");
    a.href = url;
    a.download = `frames_${videoFile?.name.split(".")[0] || "video"}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ============================================================================
  // Utilities
  // ============================================================================

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const estimatedFrames = videoInfo
    ? Math.floor(videoInfo.duration * settings.fps)
    : 0;

  const estimatedSize = estimatedFrames * 100 * 1024; // Rough estimate

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div
      className="min-h-screen bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 p-4 md:p-8"
      dir="rtl"
    >
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="text-center space-y-4 py-8">
          <div className="inline-flex items-center gap-3 bg-white/10 backdrop-blur-xl px-6 py-3 rounded-full border border-white/20">
            <Film className="w-8 h-8 text-purple-300" />
            <h1 className="text-3xl md:text-4xl font-bold text-white">
              מחלץ פריימים מווידאו
            </h1>
          </div>
          <p className="text-purple-200 text-lg max-w-2xl mx-auto">
            חילוץ מהיר של פריימים מווידאו עם תמיכה בהאצת GPU
          </p>

          {/* Status Indicators */}
          <div className="flex flex-wrap justify-center gap-3">
            {useWebCodecs !== null && (
              <div
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium backdrop-blur-xl border ${
                  useWebCodecs
                    ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                    : "bg-amber-500/20 text-amber-300 border-amber-500/30"
                }`}
              >
                <Zap className="w-4 h-4" />
                {useWebCodecs
                  ? "WebCodecs זמין - חילוץ מהיר"
                  : "WebCodecs לא נתמך"}
              </div>
            )}
            {isMP4BoxLoaded && (
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium bg-blue-500/20 text-blue-300 border border-blue-500/30 backdrop-blur-xl">
                <CheckCircle2 className="w-4 h-4" />
                MP4Box נטען
              </div>
            )}
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <Card className="p-4 bg-red-500/10 border-red-500/30 backdrop-blur-xl">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-red-400" />
              <p className="text-red-200">{error}</p>
              <button
                onClick={() => setError(null)}
                className="mr-auto text-red-400 hover:text-red-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </Card>
        )}

        {/* Upload Zone */}
        <Card
          className="p-12 border-2 border-dashed border-purple-400/30 hover:border-purple-400/60 transition-all cursor-pointer bg-white/5 backdrop-blur-xl hover:bg-white/10"
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <div className="flex flex-col items-center gap-4">
            {isAnalyzing ? (
              <>
                <Loader2 className="w-16 h-16 text-purple-400 animate-spin" />
                <p className="text-lg text-purple-200">מנתח את הווידאו...</p>
              </>
            ) : videoFile ? (
              <>
                <div className="p-4 bg-purple-500/20 rounded-full">
                  <Film className="w-12 h-12 text-purple-300" />
                </div>
                <div className="text-center">
                  <p className="text-lg font-medium text-white">
                    {videoFile.name}
                  </p>
                  <p className="text-sm text-purple-300">
                    {formatFileSize(videoFile.size)} • לחץ להחלפת קובץ
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className="p-4 bg-purple-500/20 rounded-full">
                  <Upload className="w-12 h-12 text-purple-300" />
                </div>
                <div className="text-center">
                  <p className="text-xl font-medium text-white">
                    גרור ושחרר וידאו כאן
                  </p>
                  <p className="text-sm text-purple-300">
                    או לחץ לבחירת קובץ • תומך בכל פורמטי הווידאו
                  </p>
                </div>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              onChange={handleFileSelect}
              className="hidden"
            />
          </div>
        </Card>

        {/* Video Info */}
        {videoInfo && (
          <Card className="p-6 bg-white/5 backdrop-blur-xl border-white/10">
            <h2 className="text-xl font-semibold mb-4 flex items-center gap-2 text-white">
              <ImageIcon className="w-5 h-5 text-purple-400" />
              מידע על הווידאו
            </h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-white/5 p-4 rounded-lg">
                <p className="text-sm text-purple-300">רזולוציה</p>
                <p className="text-lg font-medium text-white">
                  {videoInfo.width}×{videoInfo.height}
                </p>
              </div>
              <div className="bg-white/5 p-4 rounded-lg">
                <p className="text-sm text-purple-300">משך</p>
                <p className="text-lg font-medium text-white">
                  {formatDuration(videoInfo.duration)}
                </p>
              </div>
              <div className="bg-white/5 p-4 rounded-lg">
                <p className="text-sm text-purple-300">קצב פריימים</p>
                <p className="text-lg font-medium text-white">
                  {videoInfo.frameRate} FPS
                </p>
              </div>
              <div className="bg-white/5 p-4 rounded-lg">
                <p className="text-sm text-purple-300">סה״כ פריימים</p>
                <p className="text-lg font-medium text-white">
                  {videoInfo.frameCount.toLocaleString()}
                </p>
              </div>
            </div>
            {videoInfo.codec && (
              <div className="mt-4 text-sm text-purple-300">
                קודק: <span className="font-mono text-white">{videoInfo.codec}</span>
              </div>
            )}
          </Card>
        )}

        {/* Settings */}
        {videoInfo && (
          <Card className="p-6 bg-white/5 backdrop-blur-xl border-white/10">
            <h2 className="text-xl font-semibold mb-6 flex items-center gap-2 text-white">
              <Settings className="w-5 h-5 text-purple-400" />
              הגדרות חילוץ
            </h2>

            <div className="space-y-6">
              {/* FPS */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <Label className="text-purple-200">פריימים לשנייה (FPS)</Label>
                  <span className="text-sm font-medium text-white bg-white/10 px-3 py-1 rounded-full">
                    {settings.fps} FPS
                  </span>
                </div>
                <Slider
                  value={[settings.fps]}
                  onValueChange={([value]) =>
                    setSettings((prev) => ({ ...prev, fps: value }))
                  }
                  min={1}
                  max={Math.min(30, Math.floor(videoInfo.frameRate))}
                  step={1}
                  className="[&_[role=slider]]:bg-purple-500 [&_[role=slider]]:border-purple-400"
                />
                <p className="text-sm text-purple-300">
                  יחולצו כ-{estimatedFrames.toLocaleString()} פריימים •{" "}
                  {formatFileSize(estimatedSize)}
                </p>
              </div>

              {/* Resolution */}
              <div className="space-y-3">
                <div className="flex justify-between items-center">
                  <Label className="text-purple-200">רזולוציה</Label>
                  <span className="text-sm font-medium text-white bg-white/10 px-3 py-1 rounded-full">
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
                  className="[&_[role=slider]]:bg-purple-500 [&_[role=slider]]:border-purple-400"
                />
                <p className="text-sm text-purple-300">
                  {Math.round(videoInfo.width * (settings.resolution / 100))}×
                  {Math.round(videoInfo.height * (settings.resolution / 100))}
                </p>
              </div>

              {/* Format */}
              <div className="space-y-3">
                <Label className="text-purple-200">פורמט תמונה</Label>
                <Select
                  value={settings.format}
                  onValueChange={(value: "png" | "jpeg" | "webp") =>
                    setSettings((prev) => ({ ...prev, format: value }))
                  }
                >
                  <SelectTrigger className="bg-white/10 border-white/20 text-white">
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
                    <Label className="text-purple-200">איכות תמונה</Label>
                    <span className="text-sm font-medium text-white bg-white/10 px-3 py-1 rounded-full">
                      {Math.round(settings.quality * 100)}%
                    </span>
                  </div>
                  <Slider
                    value={[settings.quality * 100]}
                    onValueChange={([value]) =>
                      setSettings((prev) => ({
                        ...prev,
                        quality: value / 100,
                      }))
                    }
                    min={10}
                    max={100}
                    step={5}
                    className="[&_[role=slider]]:bg-purple-500 [&_[role=slider]]:border-purple-400"
                  />
                </div>
              )}
            </div>
          </Card>
        )}

        {/* Progress & Actions */}
        {videoInfo && (
          <Card className="p-6 bg-white/5 backdrop-blur-xl border-white/10">
            <div className="space-y-4">
              {isExtracting && (
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />
                      <p className="text-sm font-medium text-white">
                        מחלץ פריימים...
                      </p>
                    </div>
                    {extractionMethod && (
                      <span className="text-xs text-purple-300 bg-white/10 px-3 py-1 rounded-full">
                        {extractionMethod}
                      </span>
                    )}
                  </div>
                  <Progress
                    value={extractionProgress}
                    className="h-2 bg-white/10"
                  />
                  <div className="flex justify-between items-center">
                    <p className="text-xs text-purple-300">
                      {Math.round(extractionProgress)}% •{" "}
                      {extractedFrames.length} / {estimatedFrames} פריימים
                    </p>
                    <Button
                      onClick={cancelExtraction}
                      variant="ghost"
                      size="sm"
                      className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                    >
                      <X className="w-4 h-4 ml-1" />
                      ביטול
                    </Button>
                  </div>
                </div>
              )}

              {extractedFrames.length > 0 && !isExtracting && (
                <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-4">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="w-6 h-6 text-emerald-400" />
                    <div className="flex-1">
                      <p className="text-emerald-300 font-medium">
                        חילוץ הושלם בהצלחה!
                      </p>
                      <p className="text-sm text-emerald-400">
                        {extractedFrames.length} פריימים מוכנים להורדה
                        {extractionMethod && ` • ${extractionMethod}`}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <Button
                  onClick={extractFrames}
                  disabled={isExtracting}
                  className="flex-1 bg-gradient-to-r from-purple-600 to-blue-600 hover:from-purple-700 hover:to-blue-700 text-white border-0"
                  size="lg"
                >
                  {isExtracting ? (
                    <>
                      <Loader2 className="w-5 h-5 ml-2 animate-spin" />
                      מחלץ...
                    </>
                  ) : (
                    <>
                      <Film className="w-5 h-5 ml-2" />
                      התחל חילוץ
                      {useWebCodecs && <Zap className="w-4 h-4 mr-2" />}
                    </>
                  )}
                </Button>

                {extractedFrames.length > 0 && (
                  <Button
                    onClick={downloadAsZip}
                    variant="outline"
                    size="lg"
                    className="flex-1 bg-white/10 border-white/20 text-white hover:bg-white/20"
                  >
                    <Download className="w-5 h-5 ml-2" />
                    הורד ZIP ({extractedFrames.length})
                  </Button>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* Hidden elements for processing */}
        <div className="hidden">
          <video ref={videoRef} src={videoUrl} />
          <canvas ref={canvasRef} />
        </div>
      </div>
    </div>
  );
};

export default VideoFrameExtractor;
