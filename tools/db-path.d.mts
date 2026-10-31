// tools/db-path.d.mts — deklarasi tipe untuk tools/db-path.mjs.
// Tanpa file ini, `import { resolveDbPath } from "./db-path.mjs"` di file .ts
// gagal typecheck: TS7016 "Could not find a declaration file for module
// './db-path.mjs'. implicitly has an 'any' type."
//
// Hanya file deklarasi ini; implementasi tetap di db-path.mjs (JavaScript).
export declare function resolveDbPath(): string;
export declare function resolveDbUrl(): string;
export declare function assertDbExists(label?: string): string;
export declare function describeDb(): {
  path: string;
  url: string;
  exists: boolean;
  sizeBytes: number;
};
export declare const REPO_ROOT: string;
