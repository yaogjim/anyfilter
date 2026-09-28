/**
 * Registers {@link ./ts-resolver.mjs} so the offline tests can import the
 * extension's `.ts` sources directly. Load it with `node --import`; see
 * `scripts/unit-tests.mjs`.
 */

import { register } from 'node:module';

register('./ts-resolver.mjs', import.meta.url);