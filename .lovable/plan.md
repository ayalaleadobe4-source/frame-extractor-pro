
# תוכנית: הוספת WebGPU לעיבוד פריימים מהיר יותר

## הבנת המצב הנוכחי

המערכת כבר משתמשת ב-**WebCodecs** עם `hardwareAcceleration: "prefer-hardware"`, מה שאומר שהפענוח כבר מתבצע על ה-GPU. אבל יש עדיין צווארי בקבוק:

```text
הזרימה הנוכחית:
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  VideoFrame │ →  │  Canvas 2D  │ →  │  toBlob()   │ →  │    ZIP      │
│   (GPU)     │    │   (CPU!)    │    │   (CPU!)    │    │   (CPU)     │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
     מהיר              איטי!             איטי!
```

הבעיה: `ctx.drawImage()` ו-`canvas.toBlob()` עובדים על ה-CPU, וזה יוצר צוואר בקבוק גם כשהפענוח מהיר.

## מה WebGPU יכול לשפר

WebGPU יכול לשפר את שלב **עיבוד התמונה** (resize, המרה לפורמט), אבל לא את שלב הפענוח (זה כבר עובד על GPU דרך WebCodecs).

### אפשרויות שיפור עם WebGPU:

1. **OffscreenCanvas + ImageBitmap** - שיפור קל, ללא WebGPU
2. **WebGPU Compute Shaders** - עיבוד resize על GPU (מורכב, תמיכה מוגבלת)
3. **ImageEncoder API** (טרם זמין ברוב הדפדפנים)

## המלצה: שיפור ביניים ללא WebGPU

WebGPU עדיין לא נתמך בכל הדפדפנים (Chrome 113+, Edge 113+, Firefox Nightly בלבד, לא Safari).

**פתרון טוב יותר**: שימוש ב-**OffscreenCanvas** ב-**Web Worker** לעיבוד מקבילי:

```text
פייפליין משופר:
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  VideoFrame │ →  │  Worker +   │ →  │ Blob Pool   │
│   (GPU)     │    │ OffscreenC  │    │ (Parallel)  │
└─────────────┘    └─────────────┘    └─────────────┘
     מהיר           לא חוסם UI        המרה מקבילית
```

## אופציה: הוספת WebGPU לעתיד

אם בכל זאת רוצים WebGPU:

```typescript
// בדיקת תמיכה
if ('gpu' in navigator) {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  
  // יצירת Texture מ-VideoFrame
  device.queue.copyExternalImageToTexture(
    { source: videoFrame },
    { texture: gpuTexture },
    [width, height]
  );
  
  // Compute shader ל-resize/processing
  // ... (מאות שורות קוד)
}
```

**בעיות עם WebGPU:**
- קוד מורכב מאוד (shaders, pipelines, buffers)
- תמיכה חלקית בדפדפנים
- לא בטוח שיהיה שיפור משמעותי על פני OffscreenCanvas
- עדיין צריך להמיר ל-PNG/JPEG בסוף (CPU)

## ההמלצה הסופית

במקום WebGPU, מומלץ לשפר עם:

1. **OffscreenCanvas** - ציור ב-Worker ללא חסימת UI
2. **Batch toBlob** - המרת מספר פריימים במקביל
3. **createImageBitmap** - יעיל יותר מ-drawImage

**זה יתן שיפור של פי 2-3 בלי מורכבות של WebGPU.**

## שלבי המימוש המומלץ

### שלב 1: יצירת Web Worker לעיבוד פריימים
- `src/workers/frameProcessor.worker.ts` - Worker שמקבל VideoFrame ומחזיר Blob

### שלב 2: שימוש ב-OffscreenCanvas
- העברת ה-canvas ל-Worker עם `transferControlToOffscreen()`
- ציור ועיבוד ללא חסימת ה-Main Thread

### שלב 3: עיבוד מקבילי
- Pool של Workers (2-4 במקביל)
- Queue של פריימים לעיבוד

### שלב 4 (עתידי): WebGPU אופציונלי
- רק אם יש תמיכה בדפדפן
- Compute shader ל-resize
- Fallback ל-OffscreenCanvas

## סיכום

| שיטה | מהירות | תמיכה בדפדפנים | מורכבות |
|------|--------|----------------|---------|
| נוכחי (Canvas 2D) | בסיסי | 100% | נמוכה |
| OffscreenCanvas + Worker | x2-3 | 95%+ | בינונית |
| WebGPU | x3-5 (תיאורטי) | ~60% | גבוהה מאוד |

**המלצה: להתחיל עם OffscreenCanvas + Worker** - שיפור משמעותי עם תאימות גבוהה.

האם להמשיך עם הגישה המומלצת (OffscreenCanvas + Worker) או לנסות WebGPU למרות המורכבות?
