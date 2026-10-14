import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; done: number; total: number }
  | { kind: "error"; message: string };

const CHECK_EVERY = 6 * 3_600_000;

/** Checks GitHub Releases on start and every few hours. */
export function useUpdater() {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [version, setVersion] = useState("");

  const run = useCallback(async (manual = false) => {
    if (!api.inTauri) return;
    if (manual) setState({ kind: "checking" });
    try {
      const update = await check();
      setState(update ? { kind: "available", update } : { kind: "none" });
    } catch (e) {
      // Background checks fail quietly (offline, GitHub hiccup); manual ones report.
      setState(manual ? { kind: "error", message: String(e) } : { kind: "idle" });
    }
  }, []);

  useEffect(() => {
    if (!api.inTauri) return;
    getVersion().then(setVersion).catch(() => {});
    run();
    const t = setInterval(() => run(), CHECK_EVERY);
    return () => clearInterval(t);
  }, [run]);

  const install = useCallback(async () => {
    if (state.kind !== "available") return;
    const update = state.update;
    let done = 0;
    let total = 0;
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        if (ev.event === "Progress") done += ev.data.chunkLength;
        setState({ kind: "downloading", update, done, total });
      });
      await relaunch(); // on Windows the installer usually restarts the app itself
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }, [state]);

  return { state, version, check: () => run(true), install };
}
