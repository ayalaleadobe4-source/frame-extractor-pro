import { ViteSSG } from 'vite-ssg/single-page';
import App from "./App.tsx";
import "./index.css";

// הפונקציה הזו מחליפה את ה-createRoot הרגיל. 
// היא תדאג לעשות רינדור בשרת בזמן הבנייה, ו-Hydration בדפדפן אצל הלקוח.
export const createApp = ViteSSG(App);
