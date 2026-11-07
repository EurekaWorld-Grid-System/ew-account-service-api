import { GridName } from './types';

// OpenSim identifies a user by first + last name. A username is one or two words:
// - two words "First Last" → grid account "First Last";
// - one word "name" → grid account "name EW" (the viewer adds "EW" itself when only
//   one word is typed at login). Legacy viewers add "Resident" instead, so a pre-BMS
//   "name Resident" grid account also takes a one-word username.
export const GRID_LAST_NAME = 'EW';
export const LEGACY_GRID_LAST_NAME = 'Resident';

// Robust accepts names of [a-zA-Z0-9_] only (EW_UserAccountService.IsValidName);
// 64 = useraccounts.FirstName/LastName column size. One space between two words.
const WORD = '[A-Za-z0-9_]{1,64}';
export const USERNAME_RE = new RegExp(`^${WORD}( ${WORD})?$`);

// A two-word username ending in "EW" or "Resident" would be the same grid account as
// the one-word username, so it is not allowed.
const RESERVED_LAST_NAMES = [GRID_LAST_NAME, LEGACY_GRID_LAST_NAME].map(n => n.toLowerCase());

export function isValidUsername(username: string): boolean {
  if (!USERNAME_RE.test(username)) return false;
  const parts = username.split(' ');
  return parts.length === 1 || !RESERVED_LAST_NAMES.includes(parts[1].toLowerCase());
}

/** The grid name a new account is created with. */
export function gridNameFor(username: string): GridName {
  const [firstName, lastName] = username.split(' ');
  return lastName ? { firstName, lastName } : { firstName, lastName: GRID_LAST_NAME };
}

/** Every grid name that would take this username. */
export function conflictingGridNames(username: string): GridName[] {
  const [firstName, lastName] = username.split(' ');
  if (lastName) return [{ firstName, lastName }];
  return [
    { firstName, lastName: GRID_LAST_NAME },
    { firstName, lastName: LEGACY_GRID_LAST_NAME },
  ];
}
