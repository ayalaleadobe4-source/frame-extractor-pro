import { useState, useRef, useCallback } from "react";
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
} from "lucide-react";
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

const VideoFrameExtractor = () => {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionProgress, setExtractionProgress] = useState(0);
  const [extractedFrames, setExtractedFrames] = useState<Blob[]>([]);
  const [useWebCodecs, setUseWebCodecs] = useState<boolean | null>(null);
  const [extractionMethod, setExtractionMethod] = useState("");
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

  const supportsWebCodecs = useCallback(() => {
    return "VideoDecoder" in window && "EncodedVideoChunk" in window;
  }, []);

  const getVideoFpsFromFile = async (file: File) => {
    return new Promise<{ fps: number; frameCount: number; codec?: string; trackId?: number } | null>(
      (resolve) => {
        const mp4boxFile = MP4Box.createFile();
        mp4boxFile.onReady = (info: any) => {
          const videoTrack = info.tracks.find((t: any) => t.type === "video");
          if (videoTrack) {
            const fps = videoTrack.nb_samples / (videoTrack.duration / videoTrack.timescale);
            resolve({
              fps: Math.round(fps * 100) / 100,
              frameCount: videoTrack.nb_samples,
              codec: videoTrack.codec,
              trackId: videoTrack.id,
            });
          } else {
            resolve(null);
          }
        };
        mp4boxFile.onError = () => resolve(null);

        const reader = new FileReader();
        reader.onload = () => {
          const buffer = reader.result as ArrayBuffer;
          (buffer as any).fileStart = 0;
          mp4boxFile.appendBuffer(buffer);
          mp4boxFile.flush();
        };
        reader.readAsArrayBuffer(file);
      }
    );
  };

  const extractFramesWebCodecs = async (
    file: File,
    videoInfo: VideoInfo,
    settings: ExtractionSettings,
    onProgress: (progress: number) => void
  ): Promise<Blob[]> => {
    return new Promise(async (resolve, reject) => {
      const frames: Blob[] = [];
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d")!;
      const outputWidth = Math.round(videoInfo.width * (settings.resolution / 100));
      const outputHeight = Math.round(videoInfo.height * (settings.resolution / 100));
      canvas.width = outputWidth;
      canvas.height = outputHeight;

      const frameIntervalUs = 1000000 / settings.fps;
      let lastExtractedTimestamp = -frameIntervalUs;
      const targetFrameCount = Math.floor(videoInfo.duration * settings.fps);
      let processedCount = 0;

      const mimeType = `image/${settings.format}`;
      const quality = settings.format === "png" ? undefined : settings.quality;
      const pendingBlobs: Promise<void>[] = [];

      let decoderClosed = false;

      const mp4boxFile = MP4Box.createFile();
      let videoTrackId: number | null = null;

      const decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          const ts = frame.timestamp;
          if (ts - lastExtractedTimestamp >= frameIntervalUs * 0.9) {
            lastExtractedTimestamp = ts;
            ctx.drawImage(frame, 0, 0, outputWidth, outputHeight);

            const blobPromise = new Promise<void>((res) => {
              canvas.toBlob(
                (blob) => {
                  if (blob) {
                    frames.push(blob);
                    processedCount++;
                    onProgress((processedCount / targetFrameCount) * 100);
                  }
                  res();
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
          if (!decoderClosed) reject(e);
        },
      });

      mp4boxFile.onReady = (info: any) => {
        const videoTrack = info.tracks.find((t: any) => t.type === "video");
        if (!videoTrack) return reject(new Error("No video track found"));

        videoTrackId = videoTrack.id;

        let description: ArrayBuffer | undefined = undefined;
        if (videoTrack.codec.startsWith("avc1") && videoTrack.avcC) {
          description = videoTrack.avcC;
        }

        const config: VideoDecoderConfig = {
          codec: videoTrack.codec,
          codedWidth: videoTrack.track_width || videoInfo.width,
          codedHeight: videoTrack.track_height || videoInfo.height,
          hardwareAcceleration: "prefer-hardware",
          description,
        };

        try {
          decoder.configure(config);
          mp4boxFile.setExtractionOptions(videoTrackId, null, { nbSamples: 200 });
          mp4boxFile.start();
        } catch (e) {
          reject(e);
        }
      };

      mp4boxFile.onSamples = (_trackId: number, _user: any, samples: any[]) => {
        for (const sample of samples) {
          const timescale = sample.timescale || 1000000;
          const timestampUs = (sample.cts * 1000000) / timescale;

          try {
            const chunk = new EncodedVideoChunk({
              type: sample.is_sync ? "key" : "delta",
              timestamp: timestampUs,
              duration: (sample.duration * 1000000) / timescale,
              data: sample.data,
            });
            decoder.decode(chunk);
          } catch (err) {
            console.warn("Decode chunk failed:", err);
          }
        }
      };

      mp4boxFile.onError = (err: string) => reject(new Error(err));

      // קריאה בקטעים
      const chunkSize = 1024 * 1024; // 1MB
      let offset = 0;

      const readNext = () => {
        if (offset >= file.size) {
          mp4boxFile.flush();
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
          const buf = reader.result as ArrayBuffer;
          (buf as any).fileStart = offset;
          mp4boxFile.appendBuffer(buf);
          offset += chunkSize;
          readNext();
        };
        reader.onerror = () => reject(new Error("File read error"));
        reader.readAsArrayBuffer(slice);
      };

      readNext();
    });
  };

  const extractFramesLegacy = async (
    videoInfo: VideoInfo,
    settings: ExtractionSettings,
    onProgress: (p: number) => void
  ): Promise<Blob[]> => {
    const video = videoRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const w = Math.round(videoInfo.width * (settings.resolution / 100));
    const h = Math.round(videoInfo.height * (settings.resolution / 100));
    canvas.width = w;
    canvas.height = h;

    const frames: Blob[] = [];
    const frameInterval = 1 / settings.fps;
    const total = Math.floor(videoInfo.duration * settings.fps);

    for (let i = 0; i < total; i++) {
      const t = i * frameInterval;
      await new Promise<void>((res) => {
        video.currentTime = t;
        video.onseeked = () => res();
      });

      ctx.drawImage(video, 0, 0, w, h);

      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob(res, `image/${settings.format}`, settings.format === "png" ? undefined : settings.quality)
      );

      if (blob) frames.push(blob);
      onProgress(((i + 1) / total) * 100);
    }

    return frames;
  };

  const analyzeVideo = useCallback(
    async (file: File) => {
      setIsAnalyzing(true);
      const url = URL.createObjectURL(file);
      setVideoUrl(url);

      const webCodecs = supportsWebCodecs();
      setUseWebCodecs(webCodecs);

      const mp4Info = await getVideoFpsFromFile(file);

      return new Promise<VideoInfo>((resolve) => {
        const vid = document.createElement("video");
        vid.preload = "metadata";
        vid.src = url;
        vid.onloadedmetadata = () => {
          const info: VideoInfo = {
            width: vid.videoWidth,
            height: vid.videoHeight,
            duration: vid.duration,
            frameCount: mp4Info?.frameCount || Math.floor(vid.duration * (mp4Info?.fps || 30)),
            frameRate: mp4Info?.fps || 30,
          };
          setVideoInfo(info);
          setSettings((p) => ({ ...p, fps: Math.min(p.fps, Math.floor(info.frameRate)) }));
          setIsAnalyzing(false);
          resolve(info);
        };
      });
    },
    [supportsWebCodecs]
  );

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith("video/")) return;

    setVideoFile(file);
    setExtractedFrames([]);
    setExtractionProgress(0);
    setExtractionMethod("");
    await analyzeVideo(file);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith("video/")) return;

    setVideoFile(file);
    setExtractedFrames([]);
    setExtractionProgress(0);
    setExtractionMethod("");
    await analyzeVideo(file);
  };

  const extractFrames = async () => {
    if (!videoFile || !videoInfo) return;

    setIsExtracting(true);
    setExtractedFrames([]);
    setExtractionProgress(0);

    const onProgress = (p: number) => setExtractionProgress(Math.min(p, 100));

    try {
      let frames: Blob[];
      const isMp4 = videoFile.name.toLowerCase().endsWith(".mp4") || videoFile.type === "video/mp4";

      if (useWebCodecs && isMp4) {
        setExtractionMethod("WebCodecs (GPU)");
        try {
          frames = await extractFramesWebCodecs(videoFile, videoInfo, settings, onProgress);
        } catch (err) {
          console.warn("WebCodecs נכשל → נופל ל-Legacy", err);
          setExtractionMethod("Legacy (CPU)");
          frames = await extractFramesLegacy(videoInfo, settings, onProgress);
        }
      } else {
        setExtractionMethod("Legacy (CPU)");
        frames = await extractFramesLegacy(videoInfo, settings, onProgress);
      }

      setExtractedFrames(frames);
    } catch (err) {
      console.error("חילוץ נכשל:", err);
    } finally {
      setIsExtracting(false);
    }
  };

  const downloadAsZip = async () => {
    if (!extractedFrames.length || !videoFile) return;

    const zip = new JSZip();
    const folder = zip.folder("frames");

    extractedFrames.forEach((blob, i) => {
      const num = String(i + 1).padStart(5, "0");
      folder?.file(`frame_${num}.${settings.format}`, blob);
    });

    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    const a = document.createElement("a");
    a.href = url;
    a.download = `frames_${videoFile.name.split(".")[0] || "video"}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const estimatedFrames = videoInfo ? Math.floor(videoInfo.duration * settings.fps) : 0;

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <h1 className="text-3xl font-bold mb-2">מחלץ פריימים מווידאו</h1>
      <p className="text-muted-foreground mb-6">
        העלה וידאו, בחר הגדרות והורד את כל הפריימים כקובץ ZIP
      </p>

      {useWebCodecs !== null && (
        <div className="mb-4 text-sm">
          {useWebCodecs ? (
            <span className="text-green-600">WebCodecs זמין – חילוץ מהיר עם GPU</span>
          ) : (
            <span className="text-amber-600">WebCodecs לא נתמך – שימוש בשיטה רגילה</span>
          )}
        </div>
      )}

      {/* Upload Zone */}
      <div
        className="border-2 border-dashed rounded-lg p-10 text-center cursor-pointer hover:border-primary/50 transition mb-8"
        onClick={() => fileInputRef.current?.click()}
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        {isAnalyzing ? (
          <div className="flex flex-col items-center">
            <Loader2 className="h-10 w-10 animate-spin mb-4" />
            <p>מנתח את הווידאו...</p>
          </div>
        ) : videoFile ? (
          <div>
            <Film className="mx-auto h-12 w-12 mb-4 text-primary" />
            <p className="font-medium">{videoFile.name}</p>
            <p className="text-sm text-muted-foreground mt-1">לחץ להחלפת קובץ</p>
          </div>
        ) : (
          <div>
            <Upload className="mx-auto h-12 w-12 mb-4 text-muted-foreground" />
            <p className="font-medium">גרור ושחרר וידאו כאן</p>
            <p className="text-sm text-muted-foreground mt-1">או לחץ לבחירת קובץ</p>
          </div>
        )}
      </div>

      <input
        type="file"
        ref={fileInputRef}
        accept="video/*"
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* Video Info & Settings */}
      {videoInfo && (
        <>
          <Card className="p-6 mb-8">
            <h2 className="text-xl font-semibold mb-4">מידע על הווידאו</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <Label>רזולוציה</Label>
                <p>{videoInfo.width}×{videoInfo.height}</p>
              </div>
              <div>
                <Label>משך</Label>
                <p>{formatDuration(videoInfo.duration)}</p>
              </div>
              <div>
                <Label>קצב פריימים</Label>
                <p>{videoInfo.frameRate} FPS</p>
              </div>
              <div>
                <Label>סה״כ פריימים (משוער)</Label>
                <p>{videoInfo.frameCount.toLocaleString()}</p>
              </div>
            </div>
          </Card>

          <Card className="p-6 mb-8">
            <h2 className="text-xl font-semibold mb-6">הגדרות חילוץ</h2>

            <div className="space-y-8">
              {/* FPS */}
              <div>
                <div className="flex justify-between mb-2">
                  <Label>פריימים לשנייה (FPS)</Label>
                  <span>{settings.fps} FPS</span>
                </div>
                <Slider
                  value={[settings.fps]}
                  onValueChange={([v]) => setSettings((p) => ({ ...p, fps: v }))}
                  min={1}
                  max={Math.min(30, Math.floor(videoInfo.frameRate))}
                  step={1}
                />
                <p className="text-sm text-muted-foreground mt-2">
                  יחולצו כ-{estimatedFrames.toLocaleString()} פריימים
                </p>
              </div>

              {/* Resolution */}
              <div>
                <div className="flex justify-between mb-2">
                  <Label>רזולוציה</Label>
                  <span>{settings.resolution}%</span>
                </div>
                <Slider
                  value={[settings.resolution]}
                  onValueChange={([v]) => setSettings((p) => ({ ...p, resolution: v }))}
                  min={10}
                  max={100}
                  step={10}
                />
                <p className="text-sm mt-2">
                  {Math.round(videoInfo.width * (settings.resolution / 100))} ×{" "}
                  {Math.round(videoInfo.height * (settings.resolution / 100))}
                </p>
              </div>

              {/* Format */}
              <div>
                <Label className="mb-2 block">פורמט תמונה</Label>
                <Select
                  value={settings.format}
                  onValueChange={(v: "png" | "jpeg" | "webp") =>
                    setSettings((p) => ({ ...p, format: v }))
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
                <div>
                  <div className="flex justify-between mb-2">
                    <Label>איכות תמונה</Label>
                    <span>{Math.round(settings.quality * 100)}%</span>
                  </div>
                  <Slider
                    value={[settings.quality * 100]}
                    onValueChange={([v]) => setSettings((p) => ({ ...p, quality: v / 100 }))}
                    min={10}
                    max={100}
                    step={5}
                  />
                </div>
              )}
            </div>
          </Card>

          {/* Actions & Progress */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            {isExtracting && (
              <div className="w-full max-w-md">
                <p className="text-center mb-2">
                  מחלץ פריימים... {extractionMethod && `(${extractionMethod})`}
                </p>
                <Progress value={extractionProgress} />
                <p className="text-center mt-2 text-sm">{Math.round(extractionProgress)}%</p>
              </div>
            )}

            {extractedFrames.length > 0 && !isExtracting && (
              <div className="text-center">
                <p className="text-green-600 font-medium mb-2">
                  חולצו {extractedFrames.length} פריימים בהצלחה!
                </p>
                <p className="text-sm text-muted-foreground">
                  מוכן להורדה כקובץ ZIP {extractionMethod && `• שיטה: ${extractionMethod}`}
                </p>
              </div>
            )}

            <div className="flex gap-4 justify-center mt-6">
              {isExtracting ? (
                <Button disabled>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  מחלץ...
                </Button>
              ) : (
                <Button onClick={extractFrames} size="lg">
                  התחל חילוץ
                  {useWebCodecs && <Zap className="mr-2 h-4 w-4" />}
                </Button>
              )}

              {extractedFrames.length > 0 && (
                <Button onClick={downloadAsZip} variant="outline" size="lg">
                  <Download className="mr-2 h-4 w-4" />
                  הורד ZIP ({extractedFrames.length} פריימים)
                </Button>
              )}
            </div>
          </div>
        </>
      )}

      {/* Hidden video & canvas */}
      <video ref={videoRef} src={videoUrl} className="hidden" />
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
};

export default VideoFrameExtractor;
