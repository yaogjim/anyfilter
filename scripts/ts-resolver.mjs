/**
 * Node ESM resolver hook that lets `node:test` import the extension's TypeScript
 * sources without a bundler. The project writes bundler-style extensionless
 * relative imports (`./rule`), which Node's ESM loader rejects by default; here we
 * retry with the on-disk extension. Type stripping itself is handled by Node.
 */

const CANDIDATE_EXTENSIONS = ['.ts', '.tsx', '.mjs', '.js', '/index.ts', '/index.tsx'];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw error;
    for (const extension of CANDIDATE_EXTENSIONS) {
      try {
        return await nextResolve(specifier + extension, context);
      } catch {
        // Try the next candidate extension.
      }
    }
    throw error;
  }
}