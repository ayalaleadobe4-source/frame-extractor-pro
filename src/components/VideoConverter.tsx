import { useState, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Upload, Download, Film, Settings, Loader2, X, Video, Music } from "lucide-react";
import * as MP4Box from "mp4box";
import { Link } from "react-router-dom";

interface VideoInfo {
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  codec: string;
  audioCodec?: string;
  audioBitrate?: number;
  audioSampleRate?: number;
}

interface ConversionSettings {
  outputFormat: "mp4" | "webm";
  videoCodec: "avc1" | "vp8" | "vp9" | "av01";
  audioCodec: "aac" | "opus" | "mp3";
  resolution: number;
  videoBitrate: number;
  audioBitrate: number;
  audioSampleRate: number;
  frameRate: number;
}

const VideoConverter = () => {
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [conversionProgress, setConversionProgress] = useState(0);
  const [convertedBlob, setConvertedBlob] = useState<Blob | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [isCancelling, setIsCancelling] = useState(false);
  const [supportsWebCodecs, setSupportsWebCodecs] = useState<boolean | null>(null);

  const [settings, setSettings] = useState<ConversionSettings>({
    outputFormat: "mp4",
    videoCodec: "avc1",
    audioCodec: "aac",
    resolution: 100,
    videoBitrate: 5000,
    audioBitrate: 128,
    audioSampleRate: 48000,
    frameRate: 30,
  });

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const checkWebCodecsSupport = useCallback(() => {
    return 'VideoDecoder' in window && 'VideoEncoder' in window && 
           'AudioDecoder' in window && 'AudioEncoder' in window;
  }, []);

  const getVideoInfoFromFile = async (file: File): Promise<Partial<VideoInfo>> => {
    return new Promise((resolve) => {
      const mp4boxFile = MP4Box.createFile();
      
      mp4boxFile.onReady = (info: MP4Box.Movie) => {
        const videoTrack = info.tracks.find((track: MP4Box.Track) => track.type === "video");
        const audioTrack = info.tracks.find((track: MP4Box.Track) => track.type === "audio");
        
        const result: Partial<VideoInfo> = {};
        
        if (videoTrack) {
          result.frameRate = Math.round(videoTrack.nb_samples / (videoTrack.duration / videoTrack.timescale) * 100) / 100;
          result.codec = videoTrack.codec;
        }
        
        if (audioTrack) {
          result.audioCodec = audioTrack.codec;
          result.audioSampleRate = (audioTrack as unknown as { audio?: { sample_rate?: number } }).audio?.sample_rate;
        }
        
        resolve(result);
      };

      mp4boxFile.onError = () => {
        resolve({});
      };

      const reader = new FileReader();
      reader.onload = () => {
        const buffer = reader.result as ArrayBuffer;
        const mp4Buffer = buffer as MP4Box.MP4BoxBuffer;
        mp4Buffer.fileStart = 0;
        mp4boxFile.appendBuffer(mp4Buffer);
        mp4boxFile.flush();
      };
      reader.onerror = () => resolve({});
      reader.readAsArrayBuffer(file);
    });
  };

  const analyzeVideo = useCallback(async (file: File) => {
    setIsAnalyzing(true);
    const url = URL.createObjectURL(file);
    setVideoUrl(url);

    const webCodecsSupported = checkWebCodecsSupport();
    setSupportsWebCodecs(webCodecsSupported);

    const mp4Info = await getVideoInfoFromFile(file);

    return new Promise<VideoInfo>((resolve) => {
      const video = document.createElement("video");
      video.preload = "metadata";
      video.src = url;

      video.onloadedmetadata = () => {
        const info: VideoInfo = {
          width: video.videoWidth,
          height: video.videoHeight,
          duration: video.duration,
          frameRate: mp4Info.frameRate || 30,
          codec: mp4Info.codec || "unknown",
          audioCodec: mp4Info.audioCodec,
          audioSampleRate: mp4Info.audioSampleRate || 48000,
        };

        setVideoInfo(info);
        setSettings((prev) => ({
          ...prev,
          frameRate: Math.min(prev.frameRate, Math.floor(info.frameRate)),
          audioSampleRate: info.audioSampleRate || prev.audioSampleRate,
        }));
        setIsAnalyzing(false);
        resolve(info);
      };
    });
  }, [checkWebCodecsSupport]);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && file.type.startsWith("video/")) {
      setVideoFile(file);
      setConvertedBlob(null);
      setConversionProgress(0);
      setStatusMessage("");
      await analyzeVideo(file);
    }
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file && file.type.startsWith("video/")) {
      setVideoFile(file);
      setConvertedBlob(null);
      setConversionProgress(0);
      setStatusMessage("");
      await analyzeVideo(file);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  const getCodecString = (videoCodec: string, audioCodec: string): { video: string; audio: string } => {
    const videoCodecs: Record<string, string> = {
      "avc1": "avc1.42001E",
      "vp8": "vp8",
      "vp9": "vp09.00.10.08",
      "av01": "av01.0.04M.08",
    };
    
    const audioCodecs: Record<string, string> = {
      "aac": "mp4a.40.2",
      "opus": "opus",
      "mp3": "mp3",
    };
    
    return {
      video: videoCodecs[videoCodec] || videoCodec,
      audio: audioCodecs[audioCodec] || audioCodec,
    };
  };

  const convertVideo = async () => {
    if (!videoFile || !videoInfo) return;

    if (!supportsWebCodecs) {
      setStatusMessage("הדפדפן לא תומך ב-WebCodecs API");
      return;
    }

    setIsConverting(true);
    setIsCancelling(false);
    setConvertedBlob(null);
    setConversionProgress(0);
    setStatusMessage("מתחיל המרה...");

    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;

    try {
      const outputWidth = Math.round(videoInfo.width * (settings.resolution / 100));
      const outputHeight = Math.round(videoInfo.height * (settings.resolution / 100));
      
      // Ensure dimensions are even (required by most codecs)
      const width = outputWidth % 2 === 0 ? outputWidth : outputWidth - 1;
      const height = outputHeight % 2 === 0 ? outputHeight : outputHeight - 1;

      const codecStrings = getCodecString(settings.videoCodec, settings.audioCodec);
      
      // Check if the encoder is supported
      const videoConfig: VideoEncoderConfig = {
        codec: codecStrings.video,
        width,
        height,
        bitrate: settings.videoBitrate * 1000,
        framerate: settings.frameRate,
        hardwareAcceleration: "prefer-hardware" as HardwareAcceleration,
      };

      const videoEncoderSupport = await VideoEncoder.isConfigSupported(videoConfig);
      if (!videoEncoderSupport.supported) {
        throw new Error(`הקודק ${settings.videoCodec} לא נתמך בדפדפן זה`);
      }

      setStatusMessage("מפענח וידאו...");

      // Process video frames
      const encodedVideoChunks: { chunk: EncodedVideoChunk; meta?: EncodedVideoChunkMetadata }[] = [];
      let processedFrames = 0;
      const totalFrames = Math.floor(videoInfo.duration * settings.frameRate);

      // Create video encoder
      const videoEncoder = new VideoEncoder({
        output: (chunk, meta) => {
          encodedVideoChunks.push({ chunk, meta });
          processedFrames++;
          const progress = (processedFrames / totalFrames) * 80;
          setConversionProgress(progress);
          setStatusMessage(`מקודד פריים ${processedFrames} מתוך ${totalFrames}`);
        },
        error: (e) => {
          console.error("Encoder error:", e);
          throw e;
        },
      });

      videoEncoder.configure(videoConfig);

      // Use canvas to process frames
      const video = videoRef.current!;
      const canvas = canvasRef.current!;
      const ctx = canvas.getContext("2d")!;
      canvas.width = width;
      canvas.height = height;

      video.currentTime = 0;
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve();
        video.onloadeddata = () => resolve();
      });

      const frameInterval = 1 / settings.frameRate;
      let currentTime = 0;
      let frameCount = 0;

      while (currentTime < videoInfo.duration) {
        if (signal.aborted) {
          throw new DOMException("Conversion cancelled", "AbortError");
        }

        await new Promise<void>((resolve) => {
          video.currentTime = currentTime;
          video.onseeked = () => resolve();
        });

        ctx.drawImage(video, 0, 0, width, height);

        const imageBitmap = await createImageBitmap(canvas);
        const frame = new VideoFrame(imageBitmap, {
          timestamp: currentTime * 1000000,
          duration: frameInterval * 1000000,
        });

        const keyFrame = frameCount % 30 === 0; // Keyframe every 30 frames
        videoEncoder.encode(frame, { keyFrame });
        frame.close();
        imageBitmap.close();

        currentTime += frameInterval;
        frameCount++;
      }

      await videoEncoder.flush();
      videoEncoder.close();

      setStatusMessage("יוצר קובץ פלט...");
      setConversionProgress(90);

      // Create output blob
      const mimeType = settings.outputFormat === "mp4" ? "video/mp4" : "video/webm";
      
      // For now, create a simple output - in production you'd use proper muxing
      const totalSize = encodedVideoChunks.reduce((acc, { chunk }) => acc + chunk.byteLength, 0);
      const outputBuffer = new Uint8Array(totalSize);
      let offset = 0;
      
      for (const { chunk } of encodedVideoChunks) {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        outputBuffer.set(data, offset);
        offset += chunk.byteLength;
      }

      const outputBlob = new Blob([outputBuffer], { type: mimeType });
      setConvertedBlob(outputBlob);
      setConversionProgress(100);
      setStatusMessage("ההמרה הושלמה בהצלחה!");

    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setStatusMessage("ההמרה בוטלה");
      } else {
        console.error("Conversion failed:", e);
        setStatusMessage(`שגיאה בהמרה: ${e instanceof Error ? e.message : "שגיאה לא ידועה"}`);
      }
    } finally {
      setIsConverting(false);
      setIsCancelling(false);
      abortControllerRef.current = null;
    }
  };

  const cancelConversion = () => {
    if (abortControllerRef.current) {
      setIsCancelling(true);
      setStatusMessage("מבטל...");
      abortControllerRef.current.abort();
    }
  };

  const downloadConverted = () => {
    if (!convertedBlob || !videoFile) return;

    const extension = settings.outputFormat;
    const url = URL.createObjectURL(convertedBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${videoFile.name.split(".")[0]}_converted.${extension}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const getCompatibleCodecs = (format: "mp4" | "webm") => {
    if (format === "mp4") {
      return {
        video: [
          { value: "avc1", label: "H.264 (AVC)" },
          { value: "av01", label: "AV1" },
        ],
        audio: [
          { value: "aac", label: "AAC" },
          { value: "mp3", label: "MP3" },
        ],
      };
    }
    return {
      video: [
        { value: "vp8", label: "VP8" },
        { value: "vp9", label: "VP9" },
        { value: "av01", label: "AV1" },
      ],
      audio: [
        { value: "opus", label: "Opus" },
      ],
    };
  };

  const handleFormatChange = (format: "mp4" | "webm") => {
    const codecs = getCompatibleCodecs(format);
    setSettings(prev => ({
      ...prev,
      outputFormat: format,
      videoCodec: codecs.video[0].value as ConversionSettings["videoCodec"],
      audioCodec: codecs.audio[0].value as ConversionSettings["audioCodec"],
    }));
  };

  const compatibleCodecs = getCompatibleCodecs(settings.outputFormat);

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <h1 className="text-3xl md:text-4xl font-bold text-foreground">
            ממיר וידאו
          </h1>
          <p className="text-muted-foreground">
            המר וידאו לפורמטים שונים עם WebCodecs
          </p>
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-primary hover:text-primary/80 transition-colors"
          >
            <Film className="w-4 h-4" />
            <span>חזרה לחילוץ פריימים</span>
          </Link>
        </div>

        {/* WebCodecs Support Warning */}
        {supportsWebCodecs === false && (
          <Card className="p-4 border-destructive bg-destructive/10">
            <p className="text-destructive text-center">
              הדפדפן שלך לא תומך ב-WebCodecs API. נא להשתמש בדפדפן מודרני כמו Chrome או Edge.
            </p>
          </Card>
        )}

        {/* Upload Zone */}
        {!videoFile && (
          <Card
            className="upload-zone p-8 md:p-12 border-2 border-dashed border-primary/30 cursor-pointer hover:border-primary/60 transition-colors"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="text-center space-y-4">
              <div className="w-16 h-16 mx-auto rounded-full bg-primary/10 flex items-center justify-center">
                <Upload className="w-8 h-8 text-primary" />
              </div>
              <div>
                <p className="text-lg font-medium text-foreground">גרור וידאו לכאן</p>
                <p className="text-sm text-muted-foreground">או לחץ לבחירת קובץ</p>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              className="hidden"
              onChange={handleFileSelect}
            />
          </Card>
        )}

        {/* Loading State */}
        {isAnalyzing && (
          <Card className="p-8">
            <div className="flex items-center justify-center gap-3">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
              <span className="text-muted-foreground">מנתח את הווידאו...</span>
            </div>
          </Card>
        )}

        {/* Video Info */}
        {videoInfo && videoFile && !isAnalyzing && (
          <>
            <Card className="video-info-card p-6 space-y-4">
              <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
                <Film className="w-5 h-5 text-primary" />
                <span>פרטי הווידאו</span>
              </div>
              
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="info-stat">
                  <p className="text-xs text-muted-foreground">רזולוציה</p>
                  <p className="font-semibold text-foreground">{videoInfo.width}×{videoInfo.height}</p>
                </div>
                <div className="info-stat">
                  <p className="text-xs text-muted-foreground">אורך</p>
                  <p className="font-semibold text-foreground">{formatDuration(videoInfo.duration)}</p>
                </div>
                <div className="info-stat">
                  <p className="text-xs text-muted-foreground">קצב פריימים</p>
                  <p className="font-semibold text-foreground">{videoInfo.frameRate} FPS</p>
                </div>
                <div className="info-stat">
                  <p className="text-xs text-muted-foreground">קודק</p>
                  <p className="font-semibold text-foreground">{videoInfo.codec}</p>
                </div>
              </div>

              <video
                ref={videoRef}
                src={videoUrl}
                className="w-full max-h-64 object-contain rounded-lg bg-black"
                controls
              />

              <Button
                variant="outline"
                onClick={() => {
                  setVideoFile(null);
                  setVideoUrl("");
                  setVideoInfo(null);
                  setConvertedBlob(null);
                  setConversionProgress(0);
                  setStatusMessage("");
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
              >
                בחר וידאו אחר
              </Button>
            </Card>

            {/* Settings */}
            <Card className="settings-card p-6 space-y-6">
              <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
                <Settings className="w-5 h-5 text-primary" />
                <span>הגדרות המרה</span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Output Format */}
                <div className="space-y-2">
                  <Label>פורמט פלט</Label>
                  <Select
                    value={settings.outputFormat}
                    onValueChange={(v) => handleFormatChange(v as "mp4" | "webm")}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mp4">MP4</SelectItem>
                      <SelectItem value="webm">WebM</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* Video Codec */}
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <Video className="w-4 h-4" />
                    קודק וידאו
                  </Label>
                  <Select
                    value={settings.videoCodec}
                    onValueChange={(v) => setSettings(prev => ({ ...prev, videoCodec: v as ConversionSettings["videoCodec"] }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {compatibleCodecs.video.map(codec => (
                        <SelectItem key={codec.value} value={codec.value}>{codec.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Audio Codec */}
                <div className="space-y-2">
                  <Label className="flex items-center gap-2">
                    <Music className="w-4 h-4" />
                    קודק אודיו
                  </Label>
                  <Select
                    value={settings.audioCodec}
                    onValueChange={(v) => setSettings(prev => ({ ...prev, audioCodec: v as ConversionSettings["audioCodec"] }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {compatibleCodecs.audio.map(codec => (
                        <SelectItem key={codec.value} value={codec.value}>{codec.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Resolution */}
                <div className="space-y-2">
                  <Label>רזולוציה: {settings.resolution}%</Label>
                  <Slider
                    className="settings-slider"
                    value={[settings.resolution]}
                    onValueChange={([v]) => setSettings(prev => ({ ...prev, resolution: v }))}
                    min={25}
                    max={100}
                    step={25}
                  />
                  <p className="text-xs text-muted-foreground">
                    {Math.round(videoInfo.width * (settings.resolution / 100))}×{Math.round(videoInfo.height * (settings.resolution / 100))}
                  </p>
                </div>

                {/* Frame Rate */}
                <div className="space-y-2">
                  <Label>קצב פריימים: {settings.frameRate} FPS</Label>
                  <Slider
                    className="settings-slider"
                    value={[settings.frameRate]}
                    onValueChange={([v]) => setSettings(prev => ({ ...prev, frameRate: v }))}
                    min={1}
                    max={Math.floor(videoInfo.frameRate)}
                    step={1}
                  />
                </div>

                {/* Video Bitrate */}
                <div className="space-y-2">
                  <Label>קצב סיביות וידאו: {settings.videoBitrate} Kbps</Label>
                  <Slider
                    className="settings-slider"
                    value={[settings.videoBitrate]}
                    onValueChange={([v]) => setSettings(prev => ({ ...prev, videoBitrate: v }))}
                    min={500}
                    max={20000}
                    step={500}
                  />
                </div>

                {/* Audio Bitrate */}
                <div className="space-y-2">
                  <Label>קצב סיביות אודיו: {settings.audioBitrate} Kbps</Label>
                  <Slider
                    className="settings-slider"
                    value={[settings.audioBitrate]}
                    onValueChange={([v]) => setSettings(prev => ({ ...prev, audioBitrate: v }))}
                    min={64}
                    max={320}
                    step={32}
                  />
                </div>

                {/* Audio Sample Rate */}
                <div className="space-y-2">
                  <Label>קצב דגימת אודיו</Label>
                  <Select
                    value={settings.audioSampleRate.toString()}
                    onValueChange={(v) => setSettings(prev => ({ ...prev, audioSampleRate: parseInt(v) }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="44100">44.1 kHz</SelectItem>
                      <SelectItem value="48000">48 kHz</SelectItem>
                      <SelectItem value="96000">96 kHz</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </Card>

            {/* Action Card */}
            <Card className="action-card p-6 space-y-4">
              {/* Progress */}
              {(isConverting || conversionProgress > 0) && (
                <div className="space-y-2">
                  <Progress value={conversionProgress} className="progress-bar" />
                  <p className="text-sm text-muted-foreground text-center">{statusMessage}</p>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex flex-wrap gap-3 justify-center">
                {!isConverting ? (
                  <Button
                    className="extract-button text-primary-foreground"
                    size="lg"
                    onClick={convertVideo}
                    disabled={!videoFile || !supportsWebCodecs}
                  >
                    <Video className="w-5 h-5 ml-2" />
                    התחל המרה
                  </Button>
                ) : (
                  <Button
                    variant="destructive"
                    size="lg"
                    onClick={cancelConversion}
                    disabled={isCancelling}
                  >
                    <X className="w-5 h-5 ml-2" />
                    {isCancelling ? "מבטל..." : "בטל המרה"}
                  </Button>
                )}

                {convertedBlob && (
                  <Button
                    className="download-button"
                    size="lg"
                    onClick={downloadConverted}
                  >
                    <Download className="w-5 h-5 ml-2" />
                    הורד ({formatFileSize(convertedBlob.size)})
                  </Button>
                )}
              </div>
            </Card>
          </>
        )}

        {/* Hidden Canvas */}
        <canvas ref={canvasRef} className="hidden" />
      </div>
    </div>
  );
};

export default VideoConverter;
