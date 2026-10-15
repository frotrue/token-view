import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { findApkUpdate, installApk } from "./apkUpdate";
import { isNativeMobile } from "./cloud";

export type Update = {
  version: string;
  install: (progress: (done: number, total: number) => void) => Promise<void>;
};

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "none" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; update: Update; done: number; total: number }
  /** Phone only: the system installer is open and waits for the user. */
  | { kind: "installing"; update: Update }
  | { kind: "error"; message: string };

const CHECK_EVERY = 6 * 3_600_000;
export const updatesEnabled = api.inTauri || isNativeMobile;

// Desktop: the Tauri updater (signed latest.json). Phone: the release APK.
async function find(): Promise<Update | null> {
  if (isNativeMobile) {
    const apk = await findApkUpdate(await getVersion());
    return apk && { version: apk.version, install: () => installApk(apk.url) };
  }
  const update = await check();
  return update && {
    version: update.version,
    install: async (progress) => {
      let done = 0;
      let total = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        if (ev.event === "Progress") done += ev.data.chunkLength;
        progress(done, total);
      });
      await relaunch(); // on Windows the installer usually restarts the app itself
    },
  };
}

/** Checks GitHub Releases on start, every few hours, and when the app comes back. */
export function useUpdater() {
  const [state, setState] = useState<UpdateState>({ kind: "idle" });
  const [version, setVersion] = useState("");
  const lastCheck = useRef(0);

  const run = useCallback(async (manual = false) => {
    if (!updatesEnabled) return;
    lastCheck.current = Date.now();
    if (manual) setState({ kind: "checking" });
    try {
      const update = await find();
      setState(update ? { kind: "available", update } : { kind: "none" });
    } catch (e) {
      // Background checks fail quietly (offline, GitHub hiccup); manual ones report.
      setState(manual ? { kind: "error", message: String(e) } : { kind: "idle" });
    }
  }, []);

  useEffect(() => {
    if (!updatesEnabled) return;
    getVersion().then(setVersion).catch(() => {});
    run();
    const t = setInterval(() => run(), CHECK_EVERY);
    // A phone app is resumed far more often than it is started.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // Back from the installer without updating (an update restarts the app).
      setState((s) => (s.kind === "installing" ? { kind: "available", update: s.update } : s));
      if (Date.now() - lastCheck.current > CHECK_EVERY) run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [run]);

  const install = useCallback(async () => {
    if (state.kind !== "available") return;
    const update = state.update;
    setState({ kind: "downloading", update, done: 0, total: 0 });
    try {
      await update.install((done, total) => setState({ kind: "downloading", update, done, total }));
      if (isNativeMobile) setState({ kind: "installing", update });
    } catch (e) {
      setState({ kind: "error", message: String(e) });
    }
  }, [state]);

  return { state, version, check: () => run(true), install };
}
