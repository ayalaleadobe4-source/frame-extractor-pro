

# תוכנית: שדרוג מהירות חילוץ הפריימים עם WebCodecs API

## הבעיה הנוכחית

המימוש הקיים משתמש בשיטה איטית מאוד:
```text
לולאה סדרתית:
┌─────────────────────────────────────────────────────────────┐
│  video.currentTime = X  →  המתן ל-onseeked  →  canvas.draw  │
│         ↓                                                    │
│  video.currentTime = X+1 →  המתן ל-onseeked  →  canvas.draw │
│         ↓                                                    │
│        ...  (כל פריים בנפרד, בזה אחר זה)                    │
└─────────────────────────────────────────────────────────────┘
```

**בעיות:**
- Seek סדרתי - כל פריים ממתין לסיום ה-seek של הקודם (מאות מילי-שניות לפריים)
- Canvas 2D - עובד על CPU בלבד, לא מנצל GPU
- אין עיבוד מקבילי

## הפתרון: WebCodecs API עם MP4Box

```text
WebCodecs Pipeline (מקבילי + GPU):
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│   MP4Box     │ →  │ VideoDecoder │ →  │  VideoFrame  │
│  (Demuxer)   │    │ (Hardware    │    │  (GPU-based) │
│              │    │  Accelerated)│    │              │
└──────────────┘    └──────────────┘    └──────────────┘
     הפרדת           פענוח מקבילי          ציור ישיר
     chunks          עם GPU               על canvas
```

**יתרונות:**
- פענוח חומרתי (GPU) - מהיר פי 10-50 מ-CPU
- עיבוד מקבילי של מספר פריימים במקביל
- ללא Seek - קריאה ישירה של ה-chunks מהקובץ

## שלבי המימוש

### שלב 1: הוספת ספריית getVideoFrames.js
- ספרייה מוכנה שמשלבת WebCodecs + MP4Box בצורה אופטימלית
- מיובאת מ-CDN (deno.land) - ללא צורך בהתקנה
- תומכת בקבצי MP4 עם האצת חומרה

### שלב 2: יצירת Worker לעיבוד ברקע (אופציונלי)
- העברת העיבוד ל-Web Worker
- שחרור ה-Main Thread לממשק משתמש חלק
- מניעת קפיאה בזמן עיבוד

### שלב 3: שינוי פונקציית extractFrames
לפני:
```javascript
for (let i = 0; i < framesToExtract; i++) {
  video.currentTime = i * frameInterval;
  await waitForSeek();  // איטי מאוד!
  ctx.drawImage(video, ...);
  blob = await canvas.toBlob(...);
}
```

אחרי:
```javascript
await getVideoFrames({
  videoUrl,
  onFrame(frame) {
    // פריימים מגיעים במהירות גבוהה
    // סינון לפי FPS הנדרש
    if (shouldKeepFrame(frame.timestamp)) {
      ctx.drawImage(frame, ...);
      // המרה ל-blob במקביל
    }
    frame.close();
  }
});
```

### שלב 4: אופטימיזציות נוספות
- Batching - המרת מספר פריימים ל-blob במקביל
- OffscreenCanvas - ציור ב-Worker (אם נשתמש ב-Worker)
- Throttling - בקרה על encodeQueueSize למניעת עומס

## פרטים טכניים

### תלויות חדשות
- שימוש ב-getVideoFrames.js מ-CDN (ללא התקנה ב-package.json)
- ניצול MP4Box שכבר מותקן בפרויקט

### תמיכה בפורמטים
- MP4: תמיכה מלאה עם WebCodecs
- פורמטים אחרים: fallback לשיטה הישנה

### בדיקת תמיכה בדפדפן
```javascript
if ('VideoDecoder' in window) {
  // השתמש ב-WebCodecs (מהיר)
} else {
  // Fallback לשיטה הישנה (איטי)
}
```

### הערכת שיפור ביצועים
- וידאו של 30 שניות ב-30 FPS (900 פריימים):
  - שיטה נוכחית: כ-5-10 דקות
  - עם WebCodecs: כ-10-30 שניות
  - שיפור של פי 10-30

## מגבלות
- WebCodecs נתמך רק בדפדפנים מודרניים (Chrome 94+, Edge 94+, Safari 16.4+)
- MP4 בלבד עם WebCodecs (פורמטים אחרים ישתמשו ב-fallback)
- דורש HTTPS או localhost

