import { useState, useRef, useCallback, useEffect, useMemo } from "react";
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
import { Upload, Download, Film, Loader2, Zap, AlertTriangle, Trash2 } from "lucide-react";
import JSZip from "jszip";
import * as MP4Box from "mp4box";

interface VideoInfo {
  width: number;
  height: number;
  duration: number;     // שניות
  frameCount: number;
  frameRate: number;    // fps מדויק
  codec?: string;
}

interface ExtractionSettings {
  fps: number;
  resolution: number;   // 20–100%
  quality: number;      // 0.1–1
  format: "png" | "jpeg" | "webp";
}

const MAX_FRAMES_LIMIT = 3500;
const BYTES_PER_PIXEL = 4; // RGBA

const VideoFrameExtractor = () => {
  const [videoFile, setVideoFile]         = useState<File | null>(null);
  const [videoUrl, setVideoUrl]           = useState("");
  const [videoInfo, setVideoInfo]         = useState<VideoInfo | null>(null);
  const [isAnalyzing, setIsAnalyzing]     = useState(false);
  const [isExtracting, setIsExtracting]   = useState(false);
  const [progress, setProgress]           = useState(0);
  const [extractedFrames, setExtractedFrames] = useState<Blob[]>([]);
  const [previewUrls, setPreviewUrls]     = useState<string[]>([]);
  const [errorMsg, setErrorMsg]           = useState<string | null>(null);
  const [abortCtrl, setAbortCtrl]         = useState<AbortController | null>(null);

  const [settings, setSettings] = useState<ExtractionSettings>({
    fps: 1,
    resolution: 85,
    quality: 0.88,
    format: "webp",
  });

  const [method, setMethod] = useState<"webcodecs" | "canvas">("webcodecs");

  const videoRef  = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const supportsWebCodecs = useMemo(
    () => typeof VideoDecoder !== "undefined" && typeof EncodedVideoChunk !== "undefined",
    []
  );

  // ─── ניתוח וידאו עם MP4Box ───
  const analyzeVideo = useCallback(async (file: File): Promise<VideoInfo> => {
    return new Promise((resolve, reject) => {
      const mp4box = MP4Box.createFile();
      mp4box.onError = (err: string) => reject(new Error(`MP4Box error: ${err}`));

      mp4box.onReady = (info: any) => {
        const vt = info.videoTracks?.[0];
        if (!vt) {
          reject(new Error("לא נמצאה מסלול וידאו"));
          return;
        }

        const durationSec = vt.duration / vt.timescale;
        const fps = vt.nb_samples / durationSec || 30;

        resolve({
          width: vt.track_width || 0,
          height: vt.track_height || 0,
          duration: durationSec,
          frameCount: vt.nb_samples,
          frameRate: Math.round(fps * 100) / 100,
          codec: vt.codec,
        });
      };

      const chunk = file.slice(0, 6 * 1024 * 1024); // 6MB – בדרך כלל מספיק ל-moov
      const reader = new FileReader();
      reader.onload = (e) => {
        const ab = e.target?.result as ArrayBuffer;
        (ab as any).fileStart = 0;
        mp4box.appendBuffer(ab);
        mp4box.flush();
      };
      reader.onerror = () => reject(new Error("שגיאת קריאת קובץ"));
      reader.readAsArrayBuffer(chunk);
    });
  }, []);

  const estimatedMemoryMB = useMemo(() => {
    if (!videoInfo) return 0;
    const count = Math.min(MAX_FRAMES_LIMIT, Math.floor(videoInfo.duration * settings.fps));
    const scale = settings.resolution / 100;
    const bytes = count * Math.round(videoInfo.width * scale) * Math.round(videoInfo.height * scale) * BYTES_PER_PIXEL;
    return Math.round(bytes / 1024 / 1024 * 1.4); // overhead
  }, [videoInfo, settings.fps, settings.resolution]);

  // ─── WebCodecs + MP4Box demuxer ───
  const extractWebCodecs = async (
    file: File,
    info: VideoInfo,
    cfg: ExtractionSettings,
    onProgress: (p: number) => void,
    signal: AbortSignal
  ): Promise<Blob[]> => {
    const frames: Blob[] = [];
    let processed = 0;
    const targetInterval = 1 / cfg.fps;
    let nextTargetTime = targetInterval / 2; // מתחילים קצת אחרי 0

    const mp4box = MP4Box.createFile();
    mp4box.onError = (e: string) => { throw new Error(`MP4Box: ${e}`); };

    const decoder = new VideoDecoder({
      output: async (frame: VideoFrame) => {
        if (signal.aborted) {
          frame.close();
          return;
        }

        const t = frame.timestamp / 1_000_000;
        if (t >= nextTargetTime) {
          const canvas = document.createElement("canvas");
          const w = frame.visibleRect?.width  || frame.codedWidth;
          const h = frame.visibleRect?.height || frame.codedHeight;
          const scale = cfg.resolution / 100;

          canvas.width  = Math.round(w * scale);
          canvas.height = Math.round(h * scale);

          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
            const blob = await new Promise<Blob | null>((r) =>
              canvas.toBlob((b) => r(b), `image/${cfg.format}`, cfg.quality)
            );
            if (blob) {
              frames.push(blob);
              processed++;
              onProgress((processed / Math.ceil(info.duration * cfg.fps)) * 100);
            }
          }
          nextTargetTime += targetInterval;
        }
        frame.close();
      },
      error: (e) => console.error("VideoDecoder error:", e),
    });

    return new Promise<Blob[]>((resolve, reject) => {
      mp4box.onReady = async (info: any) => {
        const track = info.videoTracks[0];
        if (!track) return reject(new Error("No video track"));

        try {
          decoder.configure({
            codec: track.codec,
            codedWidth: track.track_width,
            codedHeight: track.track_height,
            description: track.avcC || track.hevcC || track.vvcC || undefined,
          });
        } catch (err) {
          reject(new Error(`Decoder configure failed: ${err}`));
          return;
        }
      };

      mp4box.setExtractionOptions(1, null, { nbSamples: Infinity });
      mp4box.start();

      file.arrayBuffer()
        .then((ab) => {
          (ab as any).fileStart = 0;
          mp4box.appendBuffer(ab);
          mp4box.flush();
        })
        .catch(reject);

      const checkDone = setInterval(() => {
        if (signal.aborted) {
          clearInterval(checkDone);
          reject(new DOMException("Aborted", "AbortError"));
        }
        if (processed >= Math.ceil(info.duration * cfg.fps) || nextTargetTime > info.duration + 1) {
          clearInterval(checkDone);
          resolve(frames);
        }
      }, 400);
    });
  };

  // ─── Legacy Canvas fallback ───
  const extractCanvas = async (
    info: VideoInfo,
    cfg: ExtractionSettings,
    onProgress: (p: number) => void,
    signal: AbortSignal
  ): Promise<Blob[]> => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) throw new Error("Refs חסרים");

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context חסר");

    const frames: Blob[] = [];
    const step = 1 / cfg.fps;
    let time = 0;

    canvas.width  = Math.round(info.width  * (cfg.resolution / 100));
    canvas.height = Math.round(info.height * (cfg.resolution / 100));

    while (time <= info.duration + 0.1 && !signal.aborted) {
      video.currentTime = time;

      await new Promise<void>((res) => {
        const onSeeked = () => {
          video.removeEventListener("seeked", onSeeked);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(
            (blob) => {
              if (blob) frames.push(blob);
              res();
            },
            `image/${cfg.format}`,
            cfg.quality
          );
        };
        video.addEventListener("seeked", onSeeked, { once: true });
        video.addEventListener("error", () => res(), { once: true });
      });

      time += step;
      onProgress((time / (info.duration + 0.1)) * 100);
    }

    return frames;
  };

  const startExtraction = async () => {
    if (!videoFile || !videoInfo) return;

    if (estimatedMemoryMB > 1400) {
      if (!confirm(`צפוי שימוש של כ-${estimatedMemoryMB} MB זיכרון.\nזה עלול להאט או לקרוס את הדפדפן. להמשיך?`)) {
        return;
      }
    }

    const controller = new AbortController();
    setAbortCtrl(controller);
    setIsExtracting(true);
    setExtractedFrames([]);
    setPreviewUrls([]);
    setProgress(0);
    setErrorMsg(null);

    try {
      let frames: Blob[] = [];

      if (method === "webcodecs" && supportsWebCodecs) {
        frames = await extractWebCodecs(videoFile, videoInfo, settings, setProgress, controller.signal);
      } else {
        frames = await extractCanvas(videoInfo, settings, setProgress, controller.signal);
      }

      if (frames.length > MAX_FRAMES_LIMIT) {
        frames = frames.slice(0, MAX_FRAMES_LIMIT);
        setErrorMsg(`הוגבל ל-${MAX_FRAMES_LIMIT} תמונות מטעמי זיכרון`);
      }

      setExtractedFrames(frames);

      // תצוגה מקדימה – רק 6–10 תמונות
      const previews = await Promise.all(
        frames.slice(0, 9).map((b) => URL.createObjectURL(b))
      );
      setPreviewUrls(previews);
    } catch (err: any) {
      if (err.name === "AbortError") {
        setErrorMsg("החילוץ בוטל על ידך");
      } else {
        setErrorMsg(err.message || "שגיאה בחילוץ הפריימים");
      }
    } finally {
      setIsExtracting(false);
      setAbortCtrl(null);
    }
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file?.type.startsWith("video/")) return;

    setVideoFile(file);
    setVideoUrl(URL.createObjectURL(file));
    setExtractedFrames([]);
    setPreviewUrls([]);
    setErrorMsg(null);
    setVideoInfo(null);

    setIsAnalyzing(true);
    try {
      const info = await analyzeVideo(file);
      setVideoInfo(info);
    } catch (err: any) {
      setErrorMsg(`ניתוח הווידאו נכשל: ${err.message}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const downloadZip = async () => {
    if (!extractedFrames.length) return;

    const zip = new JSZip();
    extractedFrames.forEach((blob, i) => {
      zip.file(`frame_${(i + 1).toString().padStart(5, "0")}.${settings.format}`, blob);
    });

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `frames_${new Date().toISOString().slice(0,16).replace(/[:T]/g,"-")}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    return () => {
      previewUrls.forEach(URL.revokeObjectURL);
    };
  }, [previewUrls]);

  return (
    <div className="container mx-auto p-5 max-w-5xl">
      <h1 className="text-3xl font-bold mb-8 text-center">מחלץ פריימים מווידאו</h1>

      {errorMsg && (
        <div className="bg-red-50 border border-red-300 text-red-800 px-5 py-4 rounded-lg mb-8 flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 flex-shrink-0" />
          <div>{errorMsg}</div>
        </div>
      )}

      {/* העלאה */}
      <Card className="p-10 mb-10 border-2 border-dashed hover:border-primary/50 transition-colors">
        <input
          type="file"
          accept="video/mp4,video/webm,video/quicktime,mov"
          ref={fileInputRef}
          onChange={handleFileChange}
          className="hidden"
        />
        <div className="text-center">
          <Button
            size="lg"
            onClick={() => fileInputRef.current?.click()}
            disabled={isAnalyzing || isExtracting}
          >
            <Upload className="mr-2 h-5 w-5" />
            בחר וידאו (או גרור לכאן)
          </Button>
          <p className="mt-4 text-sm text-muted-foreground">
            mp4 • webm • mov — עדיף קבצים עם moov בראש (faststart)
          </p>
        </div>

        {videoUrl && (
          <video
            src={videoUrl}
            controls
            className="mt-8 max-h-80 mx-auto rounded-lg shadow-md"
          />
        )}
      </Card>

      {videoInfo && (
        <>
          {/* מידע על הווידאו */}
          <Card className="p-6 mb-8">
            <h2 className="text-xl font-semibold mb-5">פרטי הווידאו</h2>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-5 text-sm">
              <div>
                <div className="text-muted-foreground">רזולוציה</div>
                {videoInfo.width} × {videoInfo.height}
              </div>
              <div>
                <div className="text-muted-foreground">אורך</div>
                {videoInfo.duration.toFixed(1)} שניות
              </div>
              <div>
                <div className="text-muted-foreground">קצב פריימים</div>
                {videoInfo.frameRate.toFixed(3)} fps
              </div>
              <div>
                <div className="text-muted-foreground">פריימים צפויים</div>
                {Math.floor(videoInfo.duration * settings.fps)}
              </div>
            </div>

            {estimatedMemoryMB > 0 && (
              <p className="mt-5 text-sm text-amber-700">
                הערכת זיכרון: ≈ {estimatedMemoryMB} MB
              </p>
            )}
          </Card>

          {/* הגדרות */}
          <Card className="p-6 mb-8">
            <h2 className="text-xl font-semibold mb-6">הגדרות חילוץ</h2>

            <div className="grid gap-7 md:grid-cols-3">
              <div>
                <Label className="mb-1.5 block">קצב (fps)</Label>
                <Slider
                  value={[settings.fps]}
                  onValueChange={([v]) => setSettings((s) => ({ ...s, fps: v }))}
                  min={0.2}
                  max={10}
                  step={0.1}
                />
                <div className="text-sm mt-1.5">{settings.fps} fps</div>
              </div>

              <div>
                <Label className="mb-1.5 block">רזולוציה (%)</Label>
                <Slider
                  value={[settings.resolution]}
                  onValueChange={([v]) => setSettings((s) => ({ ...s, resolution: v }))}
                  min={25}
                  max={100}
                  step={5}
                />
                <div className="text-sm mt-1.5">{settings.resolution}%</div>
              </div>

              <div>
                <Label className="mb-1.5 block">פורמט</Label>
                <Select
                  value={settings.format}
                  onValueChange={(v: "png" | "jpeg" | "webp") =>
                    setSettings((s) => ({ ...s, format: v }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="webp">WebP – מומלץ</SelectItem>
                    <SelectItem value="jpeg">JPEG</SelectItem>
                    <SelectItem value="png">PNG – ללא אובדן</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="mt-8">
              <Label className="mb-1.5 block">מנוע חילוץ</Label>
              <Select
                value={method}
                onValueChange={(v: "webcodecs" | "canvas") => setMethod(v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="webcodecs" disabled={!supportsWebCodecs}>
                    WebCodecs + MP4Box (מהיר מאוד)
                  </SelectItem>
                  <SelectItem value="canvas">
                    Canvas (איטי יותר, תמיד זמין)
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </Card>

          {/* כפתורים + התקדמות */}
          <div className="flex flex-wrap justify-center gap-4 mb-8">
            <Button
              size="lg"
              onClick={startExtraction}
              disabled={isExtracting || isAnalyzing}
            >
              {isExtracting ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  מחלץ... {Math.round(progress)}%
                </>
              ) : (
                <>
                  <Zap className="mr-2 h-5 w-5" />
                  חלץ פריימים
                </>
              )}
            </Button>

            {isExtracting && (
              <Button variant="destructive" size="lg" onClick={() => abortCtrl?.abort()}>
                בטל
              </Button>
            )}

            {extractedFrames.length > 0 && (
              <>
                <Button variant="outline" size="lg" onClick={downloadZip}>
                  <Download className="mr-2 h-5 w-5" />
                  הורד ZIP ({extractedFrames.length} תמונות)
                </Button>

                <Button
                  variant="ghost"
                  size="lg"
                  onClick={() => {
                    setExtractedFrames([]);
                    setPreviewUrls([]);
                  }}
                >
                  <Trash2 className="mr-2 h-5 w-5" />
                  נקה
                </Button>
              </>
            )}
          </div>

          {progress > 0 && progress < 100 && (
            <Progress value={progress} className="mb-8 h-2.5" />
          )}

          {/* Preview */}
          {previewUrls.length > 0 && (
            <Card className="p-6">
              <h2 className="text-xl font-semibold mb-5">תצוגה מקדימה (ראשונים)</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-9 gap-3">
                {previewUrls.map((url, i) => (
                  <img
                    key={i}
                    src={url}
                    alt={`frame ${i + 1}`}
                    className="w-full aspect-video object-cover rounded shadow-sm bg-black/5"
                    loading="lazy"
                  />
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      {/* Hidden elements */}
      <video ref={videoRef} className="hidden" preload="metadata" />
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
};

export default VideoFrameExtractor;
