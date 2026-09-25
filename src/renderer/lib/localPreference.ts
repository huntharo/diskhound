/**
 * Saves a UI preference to localStorage, but only when it differs from
 * the stored value. The views persist their toggles from effects that
 * also run on every mount, so an unconditional setItem rewrote every
 * unchanged key each time a tab opened.
 *
 * Storage errors (quota, private mode) are swallowed: the preference
 * just resets next launch. `storage` is for tests.
 */
export function saveLocalPreference(
  key: string,
  value: string,
  storage?: Pick<Storage, "getItem" | "setItem">,
): void {
  try {
    const store = storage ?? window.localStorage;
    if (store.getItem(key) !== value) store.setItem(key, value);
  } catch {
    // Non-fatal — see above.
  }
}
