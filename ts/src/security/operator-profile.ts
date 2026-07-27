import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

import { BootstrapRefusedError } from "./principal-bootstrap.js";

/**
 * The operator profile holds the plaintext credential token, so it lives
 * under the same custody discipline as the key file: a real 0700 directory,
 * a regular 0600 file, never a symlink — verified at EVERY use, not just at
 * creation.
 *
 * The write discipline, shared by the ceremony's initial write and the
 * deliberate rotation:
 *
 *   - atomic: a uniquely-named temp file in the SAME directory, created
 *     exclusively at mode 0600, then rename() into place. A crash never
 *     leaves a truncated profile at the final path, and the new token never
 *     sits at a widened mode — the temp file is born at 0600;
 *   - refuse-to-overwrite on the ceremony write (the initial profile must
 *     never clobber an existing one); overwrite only on a deliberate rotate;
 *   - any failure removes the temp file: a partial write can never orphan
 *     state a later run refuses to overwrite;
 *   - the mode is re-stat'ed after the write: the permission bits are
 *     verified, not requested;
 *   - a custody directory that already exists as a symlink (or a plain file)
 *     is refused before any mkdir/chmod can follow it outside the root.
 */
export function writeProfileAtomic(input: {
  keysDir: string;
  path: string;
  profile: unknown;
  overwrite: boolean;
}): void {
  const dirStat = lstatSync(input.keysDir, { throwIfNoEntry: false });
  if (dirStat && (dirStat.isSymbolicLink() || !dirStat.isDirectory())) {
    throw new BootstrapRefusedError(
      `operator profile directory must be a real directory, not a symlink or a file: ${input.keysDir}`,
    );
  }
  mkdirSync(input.keysDir, { recursive: true });
  chmodSync(input.keysDir, 0o700);
  if (!input.overwrite && existsSync(input.path)) {
    throw new BootstrapRefusedError(
      `operator profile already exists; refusing to overwrite: ${input.path}`,
    );
  }
  const tempPath = `${input.path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  let renamed = false;
  try {
    writeFileSync(tempPath, `${JSON.stringify(input.profile, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(tempPath, input.path);
    renamed = true;
  } finally {
    if (!renamed) {
      rmSync(tempPath, { force: true });
    }
  }
  chmodSync(input.path, 0o600);
  if ((statSync(input.path).mode & 0o777) !== 0o600) {
    throw new BootstrapRefusedError(
      `operator profile permissions are wrong; expected mode 0600: ${input.path}`,
    );
  }
}

/**
 * Reads the profile with custody verified against the SAME object that is
 * read: opened once (symlinks refused via O_NOFOLLOW), fstat'ed on that
 * descriptor, read from that descriptor. A widened, swapped, or symlinked
 * profile — or a wrong directory — refuses authentication; it never silently
 * authenticates with tampered custody. Returns null only when no profile
 * file exists at all.
 */
export function readProfileWithCustody(keysDir: string, path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    if (code === "ELOOP") {
      throw new BootstrapRefusedError(
        `operator profile custody is wrong; the profile must not be a symlink: ${path}`,
      );
    }
    throw new BootstrapRefusedError(
      `operator profile cannot be opened (${code ?? "unknown error"}): ${path}`,
    );
  }
  try {
    const dirStat = lstatSync(keysDir, { throwIfNoEntry: false });
    if (
      !dirStat ||
      !dirStat.isDirectory() ||
      dirStat.isSymbolicLink() ||
      (dirStat.mode & 0o777) !== 0o700
    ) {
      throw new BootstrapRefusedError(
        `operator profile directory custody is wrong; expected a real directory at mode 0700: ${keysDir}`,
      );
    }
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new BootstrapRefusedError(
        `operator profile custody is wrong; expected a regular file at mode 0600: ${path}`,
      );
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
