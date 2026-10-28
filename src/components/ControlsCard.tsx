import type { ReactNode } from "react";
import "./chrome/mod-panel.css";

/**
 * The rounded grey panel the browser column's search and filter controls sit
 * in, above the list they filter. One component so every view of the column
 * boxes its controls the same way.
 */
export function ControlsCard({ children }: { children: ReactNode }) {
  return (
    <div className="pn-card">{children}</div>
  );
}
