

# תיקון: הוספת Description עבור H.264/AVC ב-WebCodecs

## הבעיה

השגיאה "A key frame is required after configure() or flush()" מופיעה כי עבור קודקים מסוג H.264 (AVC), ה-VideoDecoder דורש שדה `description` בקונפיגורציה. שדה זה מכיל את המידע ההכרחי (SPS/PPS) לאתחול הדיקודר.

## הפתרון

הוספת חילוץ ה-Description מה-MP4Box והעברתו לקונפיגורציית ה-Decoder.

## שלבי המימוש

### שלב 1: חילוץ ה-Description מ-MP4Box

ב-`mp4boxFile.onReady`, נחלץ את ה-description מה-track:

```typescript
mp4boxFile.onReady = (info: MP4Box.Movie) => {
  const videoTrack = info.tracks.find((track) => track.type === "video");
  
  // Get the description (extradata) for H.264/HEVC
  let description: Uint8Array | undefined;
  
  // MP4Box stores codec-specific data in the track
  const trak = mp4boxFile.getTrackById(videoTrack.id);
  if (trak?.mdia?.minf?.stbl?.stsd?.entries?.[0]) {
    const entry = trak.mdia.minf.stbl.stsd.entries[0];
    // For H.264 - avcC box
    if (entry.avcC) {
      description = new Uint8Array(entry.avcC.data || entry.avcC);
    }
    // For HEVC - hvcC box
    else if (entry.hvcC) {
      description = new Uint8Array(entry.hvcC.data || entry.hvcC);
    }
  }
  
  codecConfig = {
    codec: videoTrack.codec,
    codedWidth: videoTrack.video?.width,
    codedHeight: videoTrack.video?.height,
    hardwareAcceleration: "prefer-hardware",
    description: description, // ✅ הוספת ה-description
  };
};
```

### שלב 2: שימוש ב-getTrackById של MP4Box

MP4Box מספק את פונקציית `getTrackById` שמחזירה את כל המידע של ה-track, כולל ה-codec configuration box (avcC/hvcC).

### שלב 3: טיפול בפורמטים שונים

```text
פורמט הווידאו -> Box שמכיל Description
───────────────────────────────────────
H.264 (AVC)  -> avcC (AVC Configuration Box)
H.265 (HEVC) -> hvcC (HEVC Configuration Box)  
VP9          -> vpcC (VP9 Configuration Box)
AV1          -> av1C (AV1 Configuration Box)
```

### שלב 4: Fallback אם אין Description

אם לא מצליחים לחלץ את ה-description, נעבור אוטומטית לשיטת ה-Legacy:

```typescript
if (codecString.startsWith("avc") && !description) {
  console.warn("No AVC description found, falling back to legacy");
  throw new Error("AVC description required");
}
```

## קובץ לעריכה

`src/components/VideoFrameExtractor.tsx` - עדכון פונקציית `extractFramesWebCodecs`

## תוצאה צפויה

- חילוץ מהיר עם GPU עבור קבצי H.264/AVC
- ללא שגיאות "key frame required"
- Fallback אוטומטי לשיטה הישנה אם יש בעיה

