import { GridName } from './types';

// OpenSim identifies a user by first + last name. EurekaWorld usernames are one word,
// so the grid account is created as "<username> EW"; the viewer adds "EW" itself when
// only one word is typed at login. Legacy viewers add "Resident" instead, so a
// pre-BMS "<username> Resident" grid account also takes the username.
export const GRID_LAST_NAME = 'EW';
export const LEGACY_GRID_LAST_NAME = 'Resident';

// Robust accepts names of [a-zA-Z0-9_] only (EW_UserAccountService.IsValidName);
// 64 = useraccounts.FirstName column size.
export const USERNAME_RE = /^[A-Za-z0-9_]{1,64}$/;

/** The grid name a new account is created with. */
export function gridNameFor(username: string): GridName {
  return { firstName: username, lastName: GRID_LAST_NAME };
}

/** Every grid name that would take this username. */
export function conflictingGridNames(username: string): GridName[] {
  return [
    { firstName: username, lastName: GRID_LAST_NAME },
    { firstName: username, lastName: LEGACY_GRID_LAST_NAME },
  ];
}
