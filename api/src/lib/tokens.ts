import { randomBytes } from 'node:crypto';

/** URL-safe random token, 24 bytes = 192 bits, so pay links can't be guessed. */
export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');
