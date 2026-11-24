import { useEffect, useState } from "react";
import { kvGetJson, kvSetJson } from "../lib/kv";

/**
 * State saved in Sleet's own store (SQLite in the desktop app). `toStored`
 * picks what is written, e.g. to keep private tabs off the disk.
 */
export function usePersistentState<T>(key: string, initialValue: T, toStored?: (value: T) => T) {
  const [value, setValue] = useState<T>(() => kvGetJson(key, initialValue));

  useEffect(() => {
    kvSetJson(key, toStored ? toStored(value) : value);
  }, [key, value]);

  return [value, setValue] as const;
}
