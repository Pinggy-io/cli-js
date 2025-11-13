let chalkInstance: typeof import("chalk")["default"] | null = null;
let oraInstance: typeof import("ora")["default"] | null = null;
let uuidModule: typeof import("uuid") | null = null;

/**
 * Dynamically load chalk & ora (ESM-only dependency)
 * Works in both ESM and CJS builds.
 */
export async function loadChalk() {
  if (!chalkInstance) {
    chalkInstance = (await import("chalk")).default;
  }
  return chalkInstance;
}

export async function loadOra() {
  if (!oraInstance) {
    oraInstance = (await import("ora")).default;
  }
  return oraInstance;
}


export async function getUuid() {
  if (!uuidModule) {
    uuidModule = await import("uuid");
  }
  return uuidModule.v4();
}