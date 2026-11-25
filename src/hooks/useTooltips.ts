import { useEffect, useState } from "react";

export interface TooltipState {
  text: string;
  /** Mouse position (CSS pixels) when the tooltip was asked for. */
  x: number;
  y: number;
  /** Increases for every tooltip shown, so a stale render can be told apart. */
  seq: number;
}

const DELAY = 450;
let nextSeq = 1;

/**
 * Themed tooltips for anything with a `title`: the native tooltip is
 * suppressed (the text moves to `data-tip`) and Sleet draws its own at the
 * mouse, like the system tooltip (top-left corner just below-right of the cursor).
 */
export function useTooltips(): TooltipState | null {
  const [tip, setTip] = useState<TooltipState | null>(null);

  useEffect(() => {
    let timer: number | undefined;
    let current: HTMLElement | null = null;
    let mouse = { x: 0, y: 0 };
    const hide = () => { window.clearTimeout(timer); current = null; setTip(null); };
    const move = (event: MouseEvent) => { mouse = { x: event.clientX, y: event.clientY }; };
    const over = (event: MouseEvent) => {
      mouse = { x: event.clientX, y: event.clientY };
      const element = (event.target as HTMLElement | null)?.closest<HTMLElement>("[title], [data-tip]") ?? null;
      if (element === current) return;
      window.clearTimeout(timer);
      setTip(null);
      current = element;
      if (!element) return;
      const title = element.getAttribute("title");
      if (title !== null) {
        element.dataset.tip = title;
        element.removeAttribute("title");
      }
      if (!element.dataset.tip) return;
      timer = window.setTimeout(() => {
        if (current !== element || !element.isConnected) return;
        setTip({ text: element.dataset.tip ?? "", x: mouse.x, y: mouse.y, seq: nextSeq++ });
      }, DELAY);
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("mousemove", move, { passive: true });
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", hide, true);
    document.documentElement.addEventListener("mouseleave", hide);
    window.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mouseover", over);
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", hide, true);
      document.documentElement.removeEventListener("mouseleave", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);

  return tip;
}

/** Where a tooltip of `width`×`height` goes for a mouse at (x, y): below-right, flipped to stay on screen. */
export function tooltipPosition(tip: { x: number; y: number }, width: number, height: number) {
  const offsetX = 15;
  const offsetY = 22; // roughly the cursor's height
  let left = tip.x + offsetX;
  let top = tip.y + offsetY;
  if (left + width > window.innerWidth - 5) left = Math.max(5, tip.x - width - 5);
  if (top + height > window.innerHeight - 5) top = Math.max(5, tip.y - height - 8);
  return { left, top };
}
