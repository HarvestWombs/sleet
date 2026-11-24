import { BookOpen, Download, History, PanelLeft, Settings2 } from "lucide-react";
import type { Surface } from "../types";
import { IconButton } from "./IconButton";

interface RailProps {
  surface: Surface;
  onSurfaceChange: (surface: Surface) => void;
}

export function Rail({ surface, onSurfaceChange }: RailProps) {
  return (
    <nav className="rail" aria-label="Sleet">
      <button className="brand" aria-label="Sleet home" onClick={() => onSurfaceChange("browser")}>
        <span>S</span>
      </button>
      <div className="rail-group">
        <IconButton label="Tabs" active={surface === "browser"} onClick={() => onSurfaceChange("browser")}>
          <PanelLeft size={19} />
        </IconButton>
        <IconButton label="History" active={surface === "history"} onClick={() => onSurfaceChange("history")}>
          <History size={19} />
        </IconButton>
        <IconButton label="Downloads" active={surface === "downloads"} onClick={() => onSurfaceChange("downloads")}>
          <Download size={19} />
        </IconButton>
      </div>
      <div className="rail-bottom">
        <IconButton label="Reader mode" disabled>
          <BookOpen size={19} />
        </IconButton>
        <IconButton label="Settings" disabled>
          <Settings2 size={19} />
        </IconButton>
      </div>
    </nav>
  );
}
