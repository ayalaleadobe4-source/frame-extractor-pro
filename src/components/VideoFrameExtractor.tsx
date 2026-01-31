import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Upload, Download, Film, Settings, Image as ImageIcon, Loader2 } from "lucide-react";
import JSZip from "jszip";

interface VideoInfo {
  width: number;
  height: number;
  duration: number;
  frameCount: number;
  frameRate: number;
}

interface ExtractionSettings {
  fps: number;
  resolution: number; // percentage of original
  quality: number; // 0-1
  format: "png" | "jpeg" | "webp";
}

const VideoFrameExtractor = () => {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractionProgress, setExtractionProgress] = useState(0);
  const [extractedFrames, setExtractedFrames] = useState<Blob[]>([]);
  const [settings, setSettings] = useState<ExtractionSettings>({
    fps: 1,
    resolution: 100,
    quality: 0.9,
    format: "png",
  });
  
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const analyzeVideo = useCallback(async (file: File) => {
    setIsAnalyzing(true);
    const url = URL.createObjectURL(file);
    setVideoUrl(url);

    return new Promise<VideoInfo>((resolve) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.src = url;

      video.onloadedmetadata = () => {
        const duration = video.duration;
        const width = video.videoWidth;
        const height = video.videoHeight;
        // Estimate frame rate - we'll use 30fps as default if not detectable
        const estimatedFps = 30;
        const frameCount = Math.floor(duration * estimatedFps);

        const info: VideoInfo = {
          width,
          height,
          duration,
          frameCount,
          frameRate: estimatedFps,
        };

        setVideoInfo(info);
        setSettings((prev) => ({
          ...prev,
          fps: Math.min(prev.fps, estimatedFps),
        }));
        setIsAnalyzing(false);
        resolve(info);
      };
    });
  }, []);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && file.type.startsWith("video/")) {
      setVideoFile(file);
      setExtractedFrames([]);
      setExtractionProgress(0);
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
      await analyzeVideo(file);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const extractFrames = async () => {
    if (!videoFile || !videoInfo) return;

    setIsExtracting(true);
    setExtractedFrames([]);
    setExtractionProgress(0);

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
      setExtractionProgress(((i + 1) / framesToExtract) * 100);
    }

    setExtractedFrames(frames);
    setIsExtracting(false);
  };

  const downloadAsZip = async () => {
    if (extractedFrames.length === 0) return;

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
                    <span className="text-sm font-medium">מחלץ פריימים...</span>
                    <span className="text-sm text-muted-foreground">
                      {Math.round(extractionProgress)}%
                    </span>
                  </div>
                  <Progress value={extractionProgress} className="progress-bar" />
                </div>
              )}

              {extractedFrames.length > 0 && !isExtracting && (
                <div className="extracted-summary flex items-center gap-3 p-4 rounded-lg">
                  <ImageIcon className="w-8 h-8 text-success" />
                  <div>
                    <p className="font-medium">
                      חולצו {extractedFrames.length} פריימים בהצלחה!
                    </p>
                    <p className="text-sm text-muted-foreground">
                      מוכן להורדה כקובץ ZIP
                    </p>
                  </div>
                </div>
              )}

              <div className="flex flex-col sm:flex-row gap-3">
                <Button
                  onClick={extractFrames}
                  disabled={isExtracting || !videoFile}
                  className="extract-button flex-1"
                  size="lg"
                >
                  {isExtracting ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      מחלץ...
                    </>
                  ) : (
                    <>
                      <Film className="w-4 h-4 mr-2" />
                      התחל חילוץ
                    </>
                  )}
                </Button>

                {extractedFrames.length > 0 && (
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
          crossOrigin="anonymous"
        />
        <canvas ref={canvasRef} className="hidden" />
      </div>
    </div>
  );
};

export default VideoFrameExtractor;
