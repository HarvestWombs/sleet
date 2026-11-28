import { Plus, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { assignBinding, bindingFromEvent, conflictFor, displayBinding, removeBinding, resetAction, resolveShortcuts, type ShortcutAction, usableBinding } from "../lib/shortcuts";

/**
 * One action's keys in Settings → Keyboard shortcuts: its keys as chips (×
 * removes one), + records a new one, and Reset brings back the defaults. A
 * key another action uses is moved over after asking.
 */
export function ShortcutKeys({ action, overrides, onChange }: { action: ShortcutAction; overrides: Record<string, string[]>; onChange: (next: Record<string, string[]>) => void }) {
  const keys = resolveShortcuts(overrides)[action.id];
  const [recording, setRecording] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [pending, setPending] = useState<{ binding: string; owner: string } | null>(null);
  const recorder = useRef<HTMLButtonElement>(null);
  const changed = action.id in overrides;

  // While recording, Sleet's own shortcuts stand aside so the keys reach this box.
  useEffect(() => {
    if (!recording) return;
    document.body.dataset.recordingShortcut = "1";
    recorder.current?.focus();
    return () => { delete document.body.dataset.recordingShortcut; };
  }, [recording]);

  const record = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.shiftKey) { setRecording(false); setNote(null); return; }
    const binding = bindingFromEvent(event.nativeEvent);
    if (!binding) return; // a modifier on its own: keep waiting for the key
    if (!usableBinding(binding)) { setNote(`${displayBinding(binding)} can't be used: add Ctrl or Alt (or use a function key)`); return; }
    setRecording(false);
    if (keys.includes(binding)) { setNote(null); return; }
    const owner = conflictFor(overrides, binding, action.id);
    if (owner) { setPending({ binding, owner: owner.label }); setNote(null); return; }
    onChange(assignBinding(overrides, action.id, binding));
    setNote(null);
  };

  return (
    <span className="shortcut-keys">
      {keys.map((binding) => (
        <span className="shortcut-chip" key={binding}>
          <kbd>{displayBinding(binding)}</kbd>
          <button type="button" aria-label={`Remove ${displayBinding(binding)}`} title="Remove this key" onClick={() => onChange(removeBinding(overrides, action.id, binding))}><X size={12} /></button>
        </span>
      ))}
      {pending ? (
        <span className="shortcut-confirm">
          <small><kbd>{displayBinding(pending.binding)}</kbd> is used by “{pending.owner}”.</small>
          <button type="button" className="settings-button is-primary" onClick={() => { onChange(assignBinding(overrides, action.id, pending.binding)); setPending(null); }}>Use it here</button>
          <button type="button" className="settings-button" onClick={() => setPending(null)}>Cancel</button>
        </span>
      ) : recording ? (
        <button ref={recorder} type="button" className="shortcut-record is-recording" onKeyDown={record} onBlur={() => setRecording(false)} aria-label={`Press the new keys for ${action.label}`}>
          Press keys… <small>Esc to cancel</small>
        </button>
      ) : (
        <button type="button" className="shortcut-record" onClick={() => { setRecording(true); setNote(null); }} title="Add a key" aria-label={`Add a key for ${action.label}`}><Plus size={14} /></button>
      )}
      {changed && !recording && !pending && (
        <button type="button" className="shortcut-reset" onClick={() => onChange(resetAction(overrides, action.id))} title="Back to the default keys" aria-label={`Reset ${action.label}`}><RotateCcw size={13} /></button>
      )}
      {note && <small className="shortcut-note">{note}</small>}
    </span>
  );
}
