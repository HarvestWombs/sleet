import { useEffect, useState } from "react";
import { kvGetJson, kvSetJson, kvSubscribe } from "../lib/kv";

/**
 * State saved in Sleet's own store (SQLite in the desktop app). `toStored`
 * picks what is written, e.g. to keep private tabs off the disk. A change made
 * in another Sleet window shows up here too.
 */
export function usePersistentState<T>(key: string, initialValue: T, toStored?: (value: T) => T) {
  const [value, setValue] = useState<T>(() => kvGetJson(key, initialValue));

  useEffect(() => {
    kvSetJson(key, toStored ? toStored(value) : value);
  }, [key, value]);

  useEffect(() => kvSubscribe(key, () => setValue(kvGetJson(key, initialValue))), [key]);

  return [value, setValue] as const;
}
