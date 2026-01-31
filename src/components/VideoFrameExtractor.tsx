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

  const supportsWebCodecs = useCallback(() => {
    return "VideoDecoder" in window && "EncodedVideoChunk" in window;
  }, []);

  const getVideoFpsFromFile = async (file: File) => {
    return new Promise<{ fps: number; frameCount: number; codec?: string } | null>((resolve) => {
      const mp4boxFile = MP4Box.createFile();
      mp4boxFile.onReady = (info: any) => {
        const videoTrack = info.tracks.find((t: any) => t.type === "video");
        if (videoTrack) {
          const fps = videoTrack.nb_samples / (videoTrack.duration / videoTrack.timescale);
          resolve({
            fps: Math.round(fps * 100) / 100,
            frameCount: videoTrack.nb_samples,
            codec: videoTrack.codec,
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
    });
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
      let lastExtractedTs = -frameIntervalUs;
      const targetCount = Math.floor(videoInfo.duration * settings.fps);
      let processed = 0;

      const mime = `image/${settings.format}`;
      const quality = settings.format === "png" ? undefined : settings.quality;
      const pending: Promise<void>[] = [];

      const decoder = new VideoDecoder({
        output: (frame: VideoFrame) => {
          const ts = frame.timestamp;
          if (ts - lastExtractedTs >= frameIntervalUs * 0.85) {
            lastExtractedTs = ts;
            ctx.drawImage(frame, 0, 0, outputWidth, outputHeight);

            pending.push(
              new Promise<void>((r) =>
                canvas.toBlob((b) => {
                  if (b) {
                    frames.push(b);
                    processed++;
                    onProgress((processed / targetCount) * 100);
                  }
                  r();
                }, mime, quality)
              )
            );
          }
          frame.close();
        },
        error: (e) => reject(e),
      });

      const mp4boxFile = MP4Box.createFile();
      let trackId: number | null = null;

      mp4boxFile.onReady = (info: any) => {
        const track = info.tracks.find((t: any) => t.type === "video");
        if (!track) return reject(new Error("No video track"));

        trackId = track.id;

        let description: ArrayBuffer | undefined = undefined;

        // ניסיון 1: מתוך sample_descriptions (הכי אמין)
        if (track.sample_descriptions?.length) {
          const descEntry = track.sample_descriptions[0];
          if (descEntry?.avcC) {
            description = descEntry.avcC;
            console.log("[WebCodecs] avcC נמצא ב-sample_descriptions");
          }
        }

        // ניסיון 2: fallback ישיר על ה-track
        if (!description && track.avcC) {
          description = track.avcC;
          console.log("[WebCodecs] avcC נמצא ישירות על track");
        }

        const config: VideoDecoderConfig = {
          codec: track.codec,
          codedWidth: track.track_width || videoInfo.width,
          codedHeight: track.track_height || videoInfo.height,
          hardwareAcceleration: "prefer-hardware" as const,
          description,
        };

        console.log("[WebCodecs] codec:", track.codec);
        console.log("[WebCodecs] description קיים?", !!description);

        try {
          decoder.configure(config);
          mp4boxFile.setExtractionOptions(trackId, null, { nbSamples: 200 });
          mp4boxFile.start();
        } catch (e) {
          reject(e);
        }
      };

      mp4boxFile.onSamples = (_id: number, _u: any, samples: any[]) => {
        for (const sample of samples) {
          const timescale = sample.timescale || 1000000;
          const tsUs = Math.round((sample.cts * 1000000) / timescale);

          try {
            const chunk = new EncodedVideoChunk({
              type: sample.is_sync ? "key" : "delta",
              timestamp: tsUs,
              duration: Math.round((sample.duration * 1000000) / timescale),
              data: sample.data,
            });
            decoder.decode(chunk);
          } catch (err) {
            console.warn("[WebCodecs] decode chunk failed:", err);
          }
        }
      };

      mp4boxFile.onError = (err: string) => reject(new Error(err));

      // קריאה בקטעים
      const chunkSize = 2 * 1024 * 1024;
      let offset = 0;

      const readChunk = () => {
        if (offset >= file.size) {
          mp4boxFile.flush();
          decoder
            .flush()
            .then(async () => {
              await Promise.all(pending);
              resolve(frames);
            })
            .catch(reject);
          return;
        }

        const slice = file.slice(offset, offset + chunkSize);
        const r = new FileReader();
        r.onload = () => {
          const buf = r.result as ArrayBuffer;
          (buf as any).fileStart = offset;
          mp4boxFile.appendBuffer(buf);
          offset += chunkSize;
          readChunk();
        };
        r.onerror = () => reject(new Error("קריאת קובץ נכשלה"));
        r.readAsArrayBuffer(slice);
      };

      readChunk();
    });
  };

  const extractFramesLegacy = async (
    info: VideoInfo,
    settings: ExtractionSettings,
    onProgress: (p: number) => void
  ): Promise<Blob[]> => {
    const video = videoRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const w = Math.round(info.width * (settings.resolution / 100));
    const h = Math.round(info.height * (settings.resolution / 100));
    canvas.width = w;
    canvas.height = h;

    const frames: Blob[] = [];
    const interval = 1 / settings.fps;
    const total = Math.floor(info.duration * settings.fps);

    for (let i = 0; i < total; i++) {
      const time = i * interval;
      await new Promise<void>((res) => {
        video.currentTime = time;
        const onSeek = () => {
          video.removeEventListener("seeked", onSeek);
          res();
        };
        video.addEventListener("seeked", onSeek);
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

  const analyzeVideo = useCallback(async (file: File) => {
    setIsAnalyzing(true);
    const url = URL.createObjectURL(file);
    setVideoUrl(url);

    const webCodecsOk = supportsWebCodecs();
    setUseWebCodecs(webCodecsOk);

    const mp4 = await getVideoFpsFromFile(file);

    return new Promise<VideoInfo>((resolve) => {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.src = url;
      v.onloadedmetadata = () => {
        const info: VideoInfo = {
          width: v.videoWidth,
          height: v.videoHeight,
          duration: v.duration || 0,
          frameCount: mp4?.frameCount || Math.floor(v.duration * (mp4?.fps || 30)),
          frameRate: mp4?.fps || 30,
        };
        setVideoInfo(info);
        setSettings((prev) => ({ ...prev, fps: Math.min(prev.fps, Math.floor(info.frameRate)) }));
        setIsAnalyzing(false);
        resolve(info);
      };
    });
  }, [supportsWebCodecs]);

  const handleFile = async (file: File) => {
    if (!file.type.startsWith("video/")) return;
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
      const isMp4Like = videoFile.name.toLowerCase().endsWith(".mp4") || videoFile.type === "video/mp4";

      if (useWebCodecs && isMp4Like) {
        setExtractionMethod("WebCodecs (מהיר יותר)");
        try {
          frames = await extractFramesWebCodecs(videoFile, videoInfo, settings, onProgress);
        } catch (e: any) {
          console.error("WebCodecs נכשל:", e);
          setExtractionMethod("Legacy (fallback)");
          frames = await extractFramesLegacy(videoInfo, settings, onProgress);
        }
      } else {
        setExtractionMethod("Legacy (Canvas)");
        frames = await extractFramesLegacy(videoInfo, settings, onProgress);
      }

      setExtractedFrames(frames);
    } catch (err) {
      console.error("חילוץ נכשל:", err);
    } finally {
      setIsExtracting(false);
    }
  };

  const downloadZip = async () => {
    if (!extractedFrames.length || !videoFile) return;

    const zip = new JSZip();
    const f = zip.folder("frames");

    extractedFrames.forEach((b, i) => {
      const num = String(i + 1).padStart(5, "0");
      f?.file(`frame_${num}.${settings.format}`, b);
    });

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `frames_${videoFile.name.split(".")[0] || "video"}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const estimated = videoInfo ? Math.floor(videoInfo.duration * settings.fps) : 0;

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <h1 className="text-3xl font-bold mb-2">מחלץ פריימים מווידאו</h1>
      <p className="text-muted-foreground mb-6">
        העלה וידאו, בחר הגדרות והורד ZIP של כל הפריימים
      </p>

      {useWebCodecs !== null && (
        <div className="mb-4 text-sm">
          {useWebCodecs ? (
            <span className="text-green-600">WebCodecs זמין</span>
          ) : (
            <span className="text-amber-600">WebCodecs לא זמין</span>
          )}
        </div>
      )}

      <div
        className="border-2 border-dashed rounded-lg p-10 text-center cursor-pointer hover:border-primary/50 mb-8"
        onClick={() => fileInputRef.current?.click()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) handleFile(f);
        }}
        onDragOver={(e) => e.preventDefault()}
      >
        {isAnalyzing ? (
          <div className="flex flex-col items-center">
            <Loader2 className="h-10 w-10 animate-spin mb-4" />
            <p>מנתח וידאו...</p>
          </div>
        ) : videoFile ? (
          <div>
            <Film className="mx-auto h-12 w-12 mb-4 text-primary" />
            <p className="font-medium">{videoFile.name}</p>
            <p className="text-sm text-muted-foreground">לחץ להחלפה</p>
          </div>
        ) : (
          <>
            <Upload className="mx-auto h-12 w-12 mb-4 text-muted-foreground" />
            <p>גרור ושחרר או לחץ לבחירה</p>
          </>
        )}
      </div>

      <input
        type="file"
        ref={fileInputRef}
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />

      {videoInfo && (
        <>
          <Card className="p-6 mb-8">
            <h2 className="text-xl font-semibold mb-4">מידע על הווידאו</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-muted-foreground">רזולוציה</div>
                {videoInfo.width}×{videoInfo.height}
              </div>
              <div>
                <div className="text-muted-foreground">אורך</div>
                {formatTime(videoInfo.duration)}
              </div>
              <div>
                <div className="text-muted-foreground">FPS</div>
                {videoInfo.frameRate}
              </div>
              <div>
                <div className="text-muted-foreground">פריימים משוער</div>
                {videoInfo.frameCount.toLocaleString()}
              </div>
            </div>
          </Card>

          <Card className="p-6 mb-8">
            <h2 className="text-xl font-semibold mb-6">הגדרות</h2>

            <div className="space-y-8">
              <div>
                <div className="flex justify-between mb-2">
                  <Label>FPS</Label>
                  <span>{settings.fps}</span>
                </div>
                <Slider
                  value={[settings.fps]}
                  onValueChange={([v]) => setSettings((p) => ({ ...p, fps: v }))}
                  min={1}
                  max={Math.min(30, Math.floor(videoInfo.frameRate))}
                  step={1}
                />
                <p className="text-sm text-muted-foreground mt-2">
                  ~{estimated.toLocaleString()} פריימים
                </p>
              </div>

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

              <div>
                <Label className="mb-2 block">פורמט</Label>
                <Select
                  value={settings.format}
                  onValueChange={(v: "png" | "jpeg" | "webp") => setSettings((p) => ({ ...p, format: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="png">PNG</SelectItem>
                    <SelectItem value="jpeg">JPEG</SelectItem>
                    <SelectItem value="webp">WebP</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {settings.format !== "png" && (
                <div>
                  <div className="flex justify-between mb-2">
                    <Label>איכות</Label>
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

          <div className="flex flex-col items-center gap-6">
            {isExtracting && (
              <div className="w-full max-w-md">
                <p className="text-center mb-2">
                  מחלץ... {extractionMethod && `(${extractionMethod})`}
                </p>
                <Progress value={extractionProgress} />
                <p className="text-center mt-2 text-sm">{Math.round(extractionProgress)}%</p>
              </div>
            )}

            {extractedFrames.length > 0 && !isExtracting && (
              <p className="text-green-600">
                חולצו {extractedFrames.length} תמונות בהצלחה
              </p>
            )}

            <div className="flex gap-4">
              {isExtracting ? (
                <Button disabled>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  מחלץ...
                </Button>
              ) : (
                <Button onClick={extractFrames} size="lg">
                  התחל חילוץ
                  {useWebCodecs && <Zap className="ml-2 h-4 w-4" />}
                </Button>
              )}

              {extractedFrames.length > 0 && (
                <Button variant="outline" size="lg" onClick={downloadZip}>
                  <Download className="mr-2 h-4 w-4" />
                  הורד ZIP
                </Button>
              )}
            </div>
          </div>
        </>
      )}

      <video ref={videoRef} src={videoUrl} className="hidden" controls />
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
};

export default VideoFrameExtractor;
