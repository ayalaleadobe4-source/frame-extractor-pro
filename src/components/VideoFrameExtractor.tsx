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
import { Upload, Download, Film, Loader2, Zap } from "lucide-react";
import JSZip from "jszip";
import * as MP4Box from "mp4box";

// FFmpeg – נטען דינמית
let ffmpegPromise: Promise<any> | null = null;

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
  const [extractionMethod, setExtractionMethod] = useState<"legacy" | "webcodecs" | "ffmpeg-wasm">("legacy");
  
  const [isFFmpegLoading, setIsFFmpegLoading] = useState(false);
  const [ffmpegLoadError, setFfmpegLoadError] = useState<string | null>(null);

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

  // טעינת FFmpeg – Promise singleton
  const loadFfmpeg = useCallback(async () => {
    if (ffmpegPromise) return ffmpegPromise;

    setIsFFmpegLoading(true);
    setFfmpegLoadError(null);

    ffmpegPromise = (async () => {
      try {
        const { FFmpeg } = await import("@ffmpeg/ffmpeg");
        const { toBlobURL, fetchFile } = await import("@ffmpeg/util");

        const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";
        // אם רוצים multi-thread → שנה ל-@ffmpeg/core-mt + workerURL

        const ffmpeg = new FFmpeg();

        await ffmpeg.load({
          coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
          wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
          // workerURL: ... (רק אם multi-thread)
        });

        return { ffmpeg, fetchFile };
      } catch (err: any) {
        const msg = err?.message || "טעינת FFmpeg נכשלה";
        setFfmpegLoadError(msg);
        throw err;
      } finally {
        setIsFFmpegLoading(false);
      }
    })();

    return ffmpegPromise;
  }, []);

  // פונקציית חילוץ עם FFmpeg.wasm (מעודכנת)
  const extractFramesFfmpegWasm = async (
    file: File,
    videoInfo: VideoInfo,
    settings: ExtractionSettings,
    onProgress: (p: number) => void
  ): Promise<Blob[]> => {
    const { ffmpeg, fetchFile } = await loadFfmpeg();
    const frames: Blob[] = [];
    const inputName = "input_video." + (file.name.split(".").pop() || "mp4");
    const totalExpected = Math.floor(videoInfo.duration * settings.fps) || 1;

    try {
      // כתיבת הקובץ
      await ffmpeg.writeFile(inputName, await fetchFile(file));

      const scale = settings.resolution / 100;
      const w = Math.round(videoInfo.width * scale);
      const h = Math.round(videoInfo.height * scale);

      const outPattern = `frame_%05d.${settings.format}`;

      // ביצוע הפקודה
      await ffmpeg.exec([
        "-i", inputName,
        "-vf", `fps=${settings.fps},scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
        ...(settings.format === "png" ? ["-compression_level", "6"] : ["-q:v", "3"]),
        outPattern,
      ]);

      // איסוף הפריימים
      let i = 1;
      while (true) {
        const fname = `frame_${i.toString().padStart(5, "0")}.${settings.format}`;
        try {
          const data = await ffmpeg.readFile(fname);
          const type = settings.format === "jpeg" ? "jpg" : settings.format;
          const blob = new Blob([data.buffer], { type: `image/${type}` });
          frames.push(blob);
          onProgress((i / totalExpected) * 100);
          i++;
        } catch {
          break; // אין עוד קבצים
        }
      }

      return frames;
    } catch (err) {
      console.error("FFmpeg extraction error:", err);
      throw err;
    } finally {
      // ניקוי
      try {
        await ffmpeg.deleteFile(inputName);
      } catch {}
    }
  };

  // פונקציית חילוץ legacy (canvas) – דוגמה פשוטה, תשלים לפי הצורך
  const extractFramesLegacy = async (
    videoInfo: VideoInfo,
    settings: ExtractionSettings,
    onProgress: (p: number) => void
  ): Promise<Blob[]> => {
    if (!videoRef.current || !canvasRef.current) throw new Error("Refs missing");

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas context missing");

    const frames: Blob[] = [];
    const interval = 1 / settings.fps;
    let currentTime = 0;

    canvas.width = videoInfo.width * (settings.resolution / 100);
    canvas.height = videoInfo.height * (settings.resolution / 100);

    while (currentTime < videoInfo.duration) {
      video.currentTime = currentTime;
      await new Promise((resolve) => {
        video.onseeked = () => {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(
            (blob) => {
              if (blob) frames.push(blob);
              resolve(null);
            },
            `image/${settings.format}`,
            settings.quality
          );
        };
      });

      currentTime += interval;
      onProgress((currentTime / videoInfo.duration) * 100);
    }

    return frames;
  };

  // פונקציה ראשית לחילוץ
  const extractFrames = async () => {
    if (!videoFile || !videoInfo) return;

    setIsExtracting(true);
    setExtractedFrames([]);
    setExtractionProgress(0);

    const onProgress = (p: number) => setExtractionProgress(Math.min(p, 100));

    try {
      let frames: Blob[] = [];

      if (extractionMethod === "ffmpeg-wasm") {
        frames = await extractFramesFfmpegWasm(videoFile, videoInfo, settings, onProgress);
      } else if (extractionMethod === "webcodecs" && useWebCodecs) {
        // כאן תשים את implement של WebCodecs אם יש לך
        // בינתיים fallback
        frames = await extractFramesLegacy(videoInfo, settings, onProgress);
      } else {
        frames = await extractFramesLegacy(videoInfo, settings, onProgress);
      }

      setExtractedFrames(frames);
    } catch (err) {
      console.error("חילוץ נכשל:", err);
      alert("חילוץ נכשל – נסה שיטה אחרת או קובץ קטן יותר");
    } finally {
      setIsExtracting(false);
    }
  };

  // הורדה כ-ZIP
  const downloadAsZip = async () => {
    if (!extractedFrames.length) return;

    const zip = new JSZip();
    extractedFrames.forEach((blob, i) => {
      zip.file(`frame_${(i + 1).toString().padStart(5, "0")}.${settings.format}`, blob);
    });

    const content = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(content);
    const a = document.createElement("a");
    a.href = url;
    a.download = "frames.zip";
    a.click();
    URL.revokeObjectURL(url);
  };

  // ... כאן אפשר להוסיף את שאר הפונקציות כמו analyzeVideo, handleFileSelect, handleDrop וכו'
  // לדוגמה:
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setVideoFile(file);
      setVideoUrl(URL.createObjectURL(file));
      // קריאה ל-analyzeVideo(file) וכו'
    }
  };

  const estimatedFrames = videoInfo ? Math.floor(videoInfo.duration * settings.fps) : 0;

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <h1 className="text-3xl font-bold mb-6 text-center">מחלץ פריימים מווידאו</h1>

      {/* אזור העלאה */}
      <Card className="p-8 mb-8 text-center">
        <input
          type="file"
          accept="video/*"
          ref={fileInputRef}
          onChange={handleFileSelect}
          className="hidden"
        />
        <Button onClick={() => fileInputRef.current?.click()}>
          <Upload className="mr-2 h-5 w-5" /> העלה וידאו
        </Button>
        {videoUrl && <video src={videoUrl} controls className="mt-4 max-h-64 mx-auto" />}
      </Card>

      {videoInfo && (
        <>
          <Card className="p-6 mb-8">
            <h2 className="text-xl font-semibold mb-6">מידע על הווידאו</h2>
            <p>רזולוציה: {videoInfo.width}×{videoInfo.height}</p>
            <p>אורך: {videoInfo.duration.toFixed(2)} שניות</p>
            <p>פריימים משוערים: {estimatedFrames}</p>
          </Card>

          <Card className="p-6 mb-8">
            <h2 className="text-xl font-semibold mb-6">הגדרות חילוץ</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <Label>FPS (פריימים לשנייה)</Label>
                <Slider
                  value={[settings.fps]}
                  onValueChange={([v]) => setSettings({ ...settings, fps: v })}
                  min={0.1}
                  max={10}
                  step={0.1}
                />
                <p className="text-sm mt-1">{settings.fps} fps</p>
              </div>

              <div>
                <Label>רזולוציה (%)</Label>
                <Slider
                  value={[settings.resolution]}
                  onValueChange={([v]) => setSettings({ ...settings, resolution: v })}
                  min={10}
                  max={100}
                  step={5}
                />
                <p className="text-sm mt-1">{settings.resolution}%</p>
              </div>

              <div>
                <Label>פורמט</Label>
                <Select
                  value={settings.format}
                  onValueChange={(v: "png" | "jpeg" | "webp") => setSettings({ ...settings, format: v })}
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
            </div>

            <div className="mt-8">
              <Label className="mb-2 block">שיטת חילוץ</Label>
              <Select
                value={extractionMethod}
                onValueChange={(v: "legacy" | "webcodecs" | "ffmpeg-wasm") => setExtractionMethod(v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="בחר שיטה" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="legacy">Legacy (Canvas) – איטי אך בטוח</SelectItem>
                  <SelectItem value="webcodecs" disabled={!useWebCodecs}>
                    WebCodecs – מהיר (אם נתמך)
                  </SelectItem>
                  <SelectItem value="ffmpeg-wasm">FFmpeg.wasm – מומלץ</SelectItem>
                </SelectContent>
              </Select>

              {extractionMethod === "ffmpeg-wasm" && (
                <div className="mt-4 p-4 bg-gray-100 rounded text-sm">
                  {isFFmpegLoading && (
                    <div className="flex items-center gap-2 text-blue-700">
                      <Loader2 className="h-5 w-5 animate-spin" />
                      טוען FFmpeg בפעם הראשונה... (10–30 שניות)
                    </div>
                  )}
                  {ffmpegLoadError && (
                    <div className="text-red-600">
                      שגיאה: {ffmpegLoadError} (בדוק adblock / רענן)
                    </div>
                  )}
                  {!isFFmpegLoading && !ffmpegLoadError && (
                    <p className="text-green-700">FFmpeg מוכן ✓</p>
                  )}
                </div>
              )}
            </div>
          </Card>

          <div className="flex justify-center gap-4 mb-8">
            <Button
              onClick={extractFrames}
              disabled={isExtracting || isFFmpegLoading}
              size="lg"
            >
              {isExtracting ? (
                <>
                  <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                  מחלץ... {extractionProgress.toFixed(0)}%
                </>
              ) : (
                <>
                  <Zap className="mr-2 h-5 w-5" />
                  התחל חילוץ
                </>
              )}
            </Button>

            {extractedFrames.length > 0 && (
              <Button onClick={downloadAsZip} variant="outline" size="lg">
                <Download className="mr-2 h-5 w-5" />
                הורד ZIP
              </Button>
            )}
          </div>

          {extractionProgress > 0 && (
            <Progress value={extractionProgress} className="mb-8" />
          )}
        </>
      )}

      {/* אלמנטים נסתרים */}
      <video ref={videoRef} className="hidden" />
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
};

export default VideoFrameExtractor;
