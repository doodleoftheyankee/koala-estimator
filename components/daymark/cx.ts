/** Joins class names, skipping false, null and undefined. */
export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');
