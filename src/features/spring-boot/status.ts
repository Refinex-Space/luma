/**
 * Whether a file belongs to a Spring Boot module (`spring_boot_status`), asked once per file
 * for a few seconds: the module's class path may become known later (the Java engine reads
 * jdtls's view in the background), so answers expire.
 */
import { call, commands, isTauri, type BootFileStatus } from "@/platform/ipc";

const TTL = 5000;
const cache = new Map<string, { at: number; value: Promise<BootFileStatus | null> }>();

export function bootStatus(path: string): Promise<BootFileStatus | null> {
  if (!isTauri()) return Promise.resolve(null);
  const hit = cache.get(path);
  if (hit && performance.now() - hit.at < TTL) return hit.value;
  const value = call(commands.springBootStatus(path)).catch(() => null);
  cache.set(path, { at: performance.now(), value });
  return value;
}

/** Forgets every answer (settings or the build changed). */
export function forgetBootStatus() {
  cache.clear();
}
