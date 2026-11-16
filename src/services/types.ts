// Ports of the registration flow (EurekaWorld_Account_Service_Design §6). The real
// implementations are in db.ts, robust.ts and bmsAdapter.ts; tests use fakes.

export type Organization = 'edu' | 'general';

export interface CouponInfo {
  licenseId: string;
  instituteId: string;
  instituteName: string;
  organization: Organization;
}

/** ew_index (SELECT only: the account service never writes ew_index). */
export interface IndexRepository {
  findCoupon(couponCode: string): Promise<CouponInfo | null>;
  emailExists(email: string): Promise<boolean>;
  /** account_index.username or user_index.username */
  usernameExists(username: string): Promise<boolean>;
  avatarCodeExists(avatarCode: string): Promise<boolean>;
  /** Login lookup by account_index.username (null when not in the index). */
  findLoginUser(username: string): Promise<LoginUser | null>;
  /** A BMS user from user_index + institute_index (null when not in the index). */
  findUser(bmsUserId: string): Promise<IndexedUser | null>;
}

/** ew_system (EXECUTE on its SQL SECURITY DEFINER routines only). */
export interface SystemRepository {
  /** sp_consume_service_action_token: the token's details when it existed and hadn't expired (it's deleted either way). */
  consumeServiceToken(tokenId: string): Promise<ServiceToken | null>;
}

export interface ServiceToken {
  action: string;
  subjectUserId: string;
  actingUserId: string;
}

export interface IndexedUser extends BmsUserRef {
  username: string;
  accountId: string;
  /** user_index.open_sim_user_id (the grid PrincipalID), null when unknown */
  openSimUserId: string | null;
}

/** OpenSim grid DB (SELECT only on useraccounts). */
export interface GridRepository {
  /** Any grid account whose name is one of the given (FirstName, LastName) pairs. */
  nameExists(names: GridName[]): Promise<boolean>;
  /** PrincipalID of the account with exactly this name, or null. */
  findPrincipalId(name: GridName): Promise<string | null>;
  /** True when a grid account with this PrincipalID exists. */
  principalExists(principalId: string): Promise<boolean>;
}

export interface GridName {
  firstName: string;
  lastName: string;
}

export interface RobustCreateAccount {
  first: string;
  last: string;
  password: string;
  avatar: string;
}

export interface RobustClient {
  /** Resolves on IsOK: true; throws AppError(502 REGISTRATION_FAILED) otherwise. */
  createAccount(req: RobustCreateAccount): Promise<void>;
  /** Robust POST /api/password/<principalId>. Throws AppError(502 GRID_PASSWORD_SYNC_FAILED) on failure. */
  setPassword(principalId: string, password: string): Promise<void>;
}

export interface BmsCreateUser {
  organization: Organization;
  instituteId: string;
  username: string;
  firstName: string;
  lastName: string;
  password: string;
  email: string | null;
  openSimUserId: string;
  licenseId: string;
}

export interface BmsCreatedUser {
  userId: string;
  username: string;
  accountId: string | null;
  indexWriteSucceeded: boolean;
}

export interface BmsAdapterClient {
  /** bms-adapter POST /users (X-Registrant-Type: User). Throws AppError(502/504) on failure. */
  createUser(req: BmsCreateUser): Promise<BmsCreatedUser>;
  /** GET /users/{id}/credentials. null when the user doesn't exist. */
  getCredentials(user: BmsUserRef): Promise<Credentials | null>;
  /** POST /users/migrate-by-username (BmsLoginFallback): true when the user is now in the index. */
  migrateByUsername(username: string): Promise<boolean>;
  /** GET /users/{id}/mfa: the active TOTP secret. null when MFA isn't enabled (404 MFA_NOT_ENABLED). */
  getMfa(user: BmsUserRef): Promise<{ authCode: string; lastVerificationOn: string | null } | null>;
  /** POST /users/{id}/mfa/verify: LastVerificationOn = now (also ends the "initial" state). */
  markMfaVerified(user: BmsUserRef): Promise<void>;
  /** POST /users/compute-hash: the BMS hash of a password with the given salt. */
  computeHash(password: string, salt: string): Promise<string>;
  /** POST /users/{id}/password/validate: false when the password is in the user's recent history. */
  isPasswordAllowed(user: BmsUserRef, newPassword: string): Promise<boolean>;
  /** PUT /users/{id}/password { newPassword, isInitial }. Throws AppError(400 PASSWORD_RECENTLY_USED) on reuse. */
  setPassword(user: BmsUserRef, newPassword: string, isInitial: boolean): Promise<void>;
}

/** bms-adapter GET /users/{id}/credentials (v39.10). The TOTP secret is NOT here (GET /users/{id}/mfa). */
export interface Credentials {
  hashCode: string;
  salt: string;
  isInitial: boolean;
  /** 'User' | 'Student' | 'Teacher', resolved by bms-adapter */
  globalRole: string;
  /** Users.UseDoubleAuth */
  hasMfa: boolean;
  /** the active DoubleAuths row exists and was never verified (LastVerificationOn NULL) */
  mfaIsInitial: boolean;
}

/** user_index ⋈ account_index row used at login (same query as ew-portal-api). */
export interface LoginUser {
  accountId: string;
  username: string;
  userId: string;
  instituteId: string;
  /** account_index.organization: 'edu' | 'general' | 'global' | 'both' (deprecated) */
  organization: string;
}

/** A BMS user as bms-adapter addresses it: X-Organization and X-Institute-Id headers. */
export interface BmsUserRef {
  userId: string;
  organization: Organization;
  instituteId: string;
}

export interface PasswordChangeDeps {
  index: IndexRepository;
  system: SystemRepository;
  grid: GridRepository;
  robust: RobustClient;
  bms: BmsAdapterClient;
  /** ROBUST_SKIP=true: the grid password is not synced (dev only). */
  robustSkip: boolean;
}

export interface RegistrationDeps {
  index: IndexRepository;
  /** Used by the password routes (registration and passwords share one deps object) */
  system: SystemRepository;
  grid: GridRepository;
  robust: RobustClient;
  bms: BmsAdapterClient;
  /** ROBUST_SKIP=true: no Robust call and no grid lookup; a random UUID stands in for the PrincipalID. */
  robustSkip: boolean;
}
