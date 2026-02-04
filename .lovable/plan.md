
# אופטימיזציית GPU - ניצול מלא של כרטיס המסך

## מה הבעיה?

הקוד הנוכחי עובד ב-100% אבל לא מנצל את ה-GPU בצורה מקסימלית בגלל:

1. **אין ניהול Backpressure** - אנחנו מזינים chunks בלי לבדוק אם ה-decoder מוכן לקבל עוד
2. **עבודה ב-Main Thread** - כל העיבוד קורה ב-thread הראשי
3. **Canvas רגיל במקום OffscreenCanvas** - גורם לחסימות בעיבוד

## הפתרון

### שלב 1: ניהול Backpressure (עיקרי)
שמירה על תור של 10-20 chunks בזיכרון ה-decoder כדי שה-GPU יעבוד ברציפות:

```text
לפני:
chunks → decoder → GPU (idle 90% מהזמן)

אחרי:
chunks → [buffer 15-20] → decoder → GPU (עובד ברציפות)
```

### שלב 2: Web Worker לעיבוד
העברת הפענוח ל-Worker נפרד כדי שה-Main Thread לא יחסום את ה-GPU:

```text
Main Thread              Worker Thread
─────────────           ──────────────
File I/O          →     VideoDecoder + GPU
UI updates        ←     Processed frames
```

### שלב 3: OffscreenCanvas
שימוש ב-OffscreenCanvas בתוך ה-Worker לעיבוד מהיר יותר של הפריימים.

---

## פרטים טכניים

### קבצים חדשים:
- `src/workers/videoDecoder.worker.ts` - Worker לפענוח הווידאו

### שינויים ב-`src/components/VideoFrameExtractor.tsx`:

#### 1. הוספת Backpressure ב-onSamples:
```typescript
mp4boxFile.onSamples = async (_trackId, _user, samples) => {
  for (const sample of samples) {
    // Wait for decoder to have capacity (keep 15-20 in queue)
    while (decoder.decodeQueueSize > 15) {
      await new Promise(r => 
        decoder.addEventListener('dequeue', r, { once: true })
      );
    }
    
    const chunk = new EncodedVideoChunk({...});
    decoder.decode(chunk);
  }
};
```

#### 2. הוספת Web Worker:
```typescript
// Worker setup
const worker = new Worker(
  new URL('../workers/videoDecoder.worker.ts', import.meta.url),
  { type: 'module' }
);

// Send file and settings to worker
worker.postMessage({ file, settings, videoInfo });

// Receive processed frames
worker.onmessage = (e) => {
  if (e.data.type === 'frame') {
    frames.push(e.data.blob);
  } else if (e.data.type === 'progress') {
    onProgress(e.data.value);
  }
};
```

#### 3. OffscreenCanvas בתוך ה-Worker:
```typescript
// In worker
const canvas = new OffscreenCanvas(width, height);
const ctx = canvas.getContext('2d');

// Draw frame directly on GPU-backed canvas
ctx.drawImage(frame, 0, 0);
const blob = await canvas.convertToBlob({ type: mimeType, quality });
```

---

## תוצאה צפויה

| מדד | לפני | אחרי |
|-----|------|------|
| ניצול GPU | ~8% | 60-90%+ |
| מהירות חילוץ | ~10 FPS | ~100+ FPS |
| תגובתיות UI | לפעמים קופא | חלקה |

## הערות
- Adobe Media Encoder משתמש בטכניקות דומות + אופטימיזציות native
- הביצועים תלויים גם בסוג הקודק (H.264 מהיר יותר מ-HEVC על רוב ה-GPUs)
- חלק מהשיפור יהיה מורגש יותר בקבצים ארוכים/גדולים
