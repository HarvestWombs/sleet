import { KeyRound, ShieldCheck } from "lucide-react";
import { useEffect, useRef } from "react";
import { hostOf } from "../lib/permissions";
import type { Prompt, PromptChoice, Toast } from "./Toasts";

/** Prompts that deserve a centered modal instead of a corner toast. */
export const isModalPrompt = (toast: Toast) => toast.prompt?.kind === "password" || toast.prompt?.kind === "remember-device";

interface ModalCopy {
  icon: "key" | "shield";
  title: string;
  detail: string;
  primary: { label: string; choice: PromptChoice };
  secondary?: { label: string; choice: PromptChoice };
}

function copyFor(prompt: Prompt): ModalCopy | null {
  if (prompt.kind === "password") {
    const site = hostOf(prompt.origin);
    if (prompt.offer === "locked") {
      return { icon: "key", title: `Save password for ${site}?`, detail: "Your passwords are locked. Unlock them to save this login.", primary: { label: "Unlock", choice: "unlock" }, secondary: { label: "Never for this site", choice: "never" } };
    }
    const update = prompt.offer === "update";
    return {
      icon: "key",
      title: update ? `Update password for ${site}?` : `Save password for ${site}?`,
      detail: prompt.username ? `For ${prompt.username}` : "No username was detected.",
      primary: { label: update ? "Update" : "Save", choice: "save" },
      secondary: update ? undefined : { label: "Never for this site", choice: "never" },
    };
  }
  if (prompt.kind === "remember-device") {
    return {
      icon: "shield",
      title: "Stop asking for your master password?",
      detail: "Sleet can save and fill passwords using this computer’s secure store. Viewing or exporting passwords still asks for the master password.",
      primary: { label: "Remember this device", choice: "turn-on" },
      secondary: { label: "Not now", choice: "not-now" },
    };
  }
  return null;
}

interface PromptModalProps {
  toast: Toast;
  onChoice: (toast: Toast, choice: PromptChoice) => void;
  /** Esc / "Not now" (for password prompts: don't save this time). */
  onDismiss: (id: string) => void;
  /** `overlay` fills its own webview; `inline` covers the page area in the chrome. */
  variant?: "overlay" | "inline";
}

/** A centered dialog over the page with a dimmed backdrop. Enter = primary, Esc = dismiss. */
export function PromptModal({ toast, onChoice, onDismiss, variant = "inline" }: PromptModalProps) {
  const primaryRef = useRef<HTMLButtonElement>(null);
  const copy = toast.prompt ? copyFor(toast.prompt) : null;

  useEffect(() => {
    primaryRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // Esc on the device offer is a "Not now" answer, so it doesn't come back every unlock.
      if (toast.prompt?.kind === "remember-device") onChoice(toast, "not-now");
      else onDismiss(toast.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toast.id]);

  if (!copy) return null;
  const Icon = copy.icon === "key" ? KeyRound : ShieldCheck;
  return (
    <div className={`prompt-modal-backdrop is-${variant}`}>
      <section className="prompt-modal" role="dialog" aria-modal="true" aria-labelledby={`modal-${toast.id}`}>
        <span className="prompt-modal-icon"><Icon size={28} /></span>
        <h2 id={`modal-${toast.id}`}>{copy.title}</h2>
        <p>{copy.detail}</p>
        <div className="prompt-modal-actions">
          {copy.secondary && <button className="prompt-modal-button" onClick={() => onChoice(toast, copy.secondary!.choice)}>{copy.secondary.label}</button>}
          {toast.prompt?.kind === "password" && <button className="prompt-modal-button" onClick={() => onDismiss(toast.id)}>Not now</button>}
          <button ref={primaryRef} className="prompt-modal-button is-primary" onClick={() => onChoice(toast, copy.primary.choice)}>{copy.primary.label}</button>
        </div>
      </section>
    </div>
  );
}
