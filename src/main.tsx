import { hydrateRoot, createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const container = document.getElementById("root")!;

// בודק אם קובץ ה-HTML כבר מכיל תוכן (כלומר עבר פרירנדר)
if (container.hasChildNodes()) {
  hydrateRoot(container, <App />);
} else {
  // אם אין תוכן (למשל כשאתה מריץ את האתר בסביבת הפיתוח שלך), עובד כרגיל
  createRoot(container).render(<App />);
}
