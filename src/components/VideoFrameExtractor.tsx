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

// FFmpeg WASM – נטען דינמית
let ffmpegModule: any = null;

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

  // ... (getVideoFpsFromFile נשאר כמו שהיה)

  const loadFfmpeg = async () => {
    if (ffmpegModule) return ffmpegModule;

    const { createFFmpeg, fetchFile } = await import("@ffmpeg/ffmpeg");
    ffmpegModule = createFFmpeg({
      log: true,
      corePath: "/ffmpeg-core.js", // או השתמש ב-core CDN אם צריך
    });

    if (!ffmpegModule.isLoaded()) {
      await ffmpegModule.load();
    }

    return ffmpegModule;
  };

  const extractFramesFfmpegWasm = async (
    file: File,
    videoInfo: VideoInfo,
    settings: ExtractionSettings,
    onProgress: (p: number) => void
  ): Promise<Blob[]> => {
    try {
      const ffmpeg = await loadFfmpeg();
      const frames: Blob[] = [];
      const inputName = "input.mp4";
      const totalFrames = Math.floor(videoInfo.duration * settings.fps);

      // כתיבת הקובץ לזיכרון של FFmpeg
      ffmpeg.FS("writeFile", inputName, await fetchFile(file));

      // פקודה לדוגמה: חילוץ פריימים כל 1/fps שניות
      const interval = 1 / settings.fps;
      const outputPattern = "frame_%05d." + settings.format;

      // דוגמה לפקודה – אפשר להתאים
      // ffmpeg -i input.mp4 -vf fps=1/5 -q:v 2 frame_%05d.jpg
      const args = [
        "-i", inputName,
        "-vf", `fps=${settings.fps}`,
        "-q:v", settings.format === "png" ? "2" : "5", // איכות
        "-s", `${Math.round(videoInfo.width * settings.resolution / 100)}x${Math.round(videoInfo.height * settings.resolution / 100)}`,
        outputPattern,
      ];

      // ניתן להוסיף progress parsing אם רוצים (דרך log)
      ffmpeg.setLogger(({ message }) => {
        // אפשר לפרסר progress אם FFmpeg מדפיס
        console.log("[FFmpeg]", message);
        // דוגמה פרימיטיבית: אם יש אחוז – לעדכן
      });

      await ffmpeg.run(...args);

      // קריאת כל הפריימים שיצאו
      for (let i = 1; i <= totalFrames; i++) {
        const fileName = `frame_${String(i).padStart(5, "0")}.${settings.format}`;
        try {
          const data = ffmpeg.FS("readFile", fileName);
          const blob = new Blob([data.buffer], { type: `image/${settings.format}` });
          frames.push(blob);
          onProgress((i / totalFrames) * 100);
        } catch (e) {
          console.warn("לא נמצא frame", i);
          break;
        }
      }

      // ניקוי
      ffmpeg.FS("unlink", inputName);
      // אפשר למחוק גם את הפלטים אם רוצים

      return frames;
    } catch (err) {
      console.error("FFmpeg WASM נכשל:", err);
      throw err;
    }
  };

  // ... (extractFramesWebCodecs נשאר כמו שהיה – עם fallback אם צריך)

  // ... (extractFramesLegacy נשאר כמו שהיה)

  const extractFrames = async () => {
    if (!videoFile || !videoInfo) return;

    setIsExtracting(true);
    setExtractedFrames([]);
    setExtractionProgress(0);

    const onProgress = (p: number) => setExtractionProgress(Math.min(p, 100));

    try {
      let frames: Blob[] = [];

      if (extractionMethod === "webcodecs" && useWebCodecs) {
        setExtractionMethod("webcodecs");
        try {
          frames = await extractFramesWebCodecs(videoFile, videoInfo, settings, onProgress);
        } catch (e) {
          console.warn("WebCodecs נכשל → fallback");
          frames = await extractFramesLegacy(videoInfo, settings, onProgress);
        }
      } else if (extractionMethod === "ffmpeg-wasm") {
        setExtractionMethod("ffmpeg-wasm");
        try {
          frames = await extractFramesFfmpegWasm(videoFile, videoInfo, settings, onProgress);
        } catch (e) {
          console.warn("FFmpeg WASM נכשל → fallback ל-legacy");
          frames = await extractFramesLegacy(videoInfo, settings, onProgress);
        }
      } else {
        setExtractionMethod("legacy");
        frames = await extractFramesLegacy(videoInfo, settings, onProgress);
      }

      setExtractedFrames(frames);
    } catch (err) {
      console.error("חילוץ נכשל:", err);
    } finally {
      setIsExtracting(false);
    }
  };

  // ... (analyzeVideo, handleFileSelect, handleDrop, downloadAsZip, formatDuration – נשארים כמו שהיו)

  const estimatedFrames = videoInfo ? Math.floor(videoInfo.duration * settings.fps) : 0;

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      {/* ... (החלק העליון עם כותרת, upload zone, video info – נשאר דומה) */}

      {videoInfo && (
        <>
          {/* ... (מידע על הווידאו) */}

          <Card className="p-6 mb-8">
            <h2 className="text-xl font-semibold mb-6">הגדרות חילוץ</h2>

            {/* FPS, Resolution, Format, Quality – נשארים כמו שהיו */}

            {/* בחירת שיטת חילוץ */}
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
                  <SelectItem value="legacy">Legacy (Canvas seek) – בטוח, איטי</SelectItem>
                  <SelectItem value="webcodecs" disabled={!useWebCodecs}>
                    WebCodecs (GPU) – מהיר אם עובד
                  </SelectItem>
                  <SelectItem value="ffmpeg-wasm">
                    FFmpeg.wasm – אמין יותר מ-WebCodecs
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-sm text-muted-foreground mt-2">
                {extractionMethod === "ffmpeg-wasm" &&
                  "טוען FFmpeg (~20-30MB בפעם הראשונה – יכול לקחת כמה שניות)"}
              </p>
            </div>
          </Card>

          {/* ... (כפתור התחל חילוץ + progress + הורד ZIP – נשאר דומה) */}
        </>
      )}

      {/* ... (hidden video & canvas) */}
    </div>
  );
};

export default VideoFrameExtractor;
