/**
 * Root entry (`/`). EdgeOne Pages maps only `index.ts` to the root path — a
 * catch-all like `[[...path]].ts` does not cover "/", and static files take
 * priority over functions, so without this file the root answers the
 * platform's own 404.
 */

export { onRequest } from './[[...path]].ts';