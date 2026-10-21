import Store from "electron-store";

/**
 * A .deb install that failed is not tried again by the app. On disk, since the
 * failure can surface across a restart: the install was handed off but the
 * next launch is still the old version.
 */
interface InstallRecordSchema {
  /** Handed to electron-updater; settled on the next launch. */
  attemptedVersion?: string;
  failedVersion?: string;
}

const installRecord = new Store<InstallRecordSchema>({
  name: "update-install",
  clearInvalidConfig: true,
});

export function recordInstallAttempt(version: string): void {
  installRecord.set("attemptedVersion", version);
}

export function recordInstallFailed(version: string): void {
  installRecord.delete("attemptedVersion");
  installRecord.set("failedVersion", version);
}

/**
 * At startup: a hand-off that relaunched into an older version than it
 * installed failed. Returns the version not to install again, if any.
 */
export function settleInstallRecord(
  running: string,
  isOlder: (a: string, b: string) => boolean
): string | null {
  const attempted = installRecord.get("attemptedVersion");
  if (attempted != null) {
    if (isOlder(running, attempted)) recordInstallFailed(attempted);
    else installRecord.delete("attemptedVersion");
  }
  const failed = installRecord.get("failedVersion") ?? null;
  // Installed after all (by hand, or a later release): nothing is failed.
  if (failed != null && !isOlder(running, failed)) {
    installRecord.delete("failedVersion");
    return null;
  }
  return failed;
}
