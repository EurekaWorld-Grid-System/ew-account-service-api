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
}

/** OpenSim grid DB (SELECT only on useraccounts). */
export interface GridRepository {
  /** Any grid account whose name is one of the given (FirstName, LastName) pairs. */
  nameExists(names: GridName[]): Promise<boolean>;
  /** PrincipalID of the account with exactly this name, or null. */
  findPrincipalId(name: GridName): Promise<string | null>;
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
}

export interface RegistrationDeps {
  index: IndexRepository;
  grid: GridRepository;
  robust: RobustClient;
  bms: BmsAdapterClient;
  /** ROBUST_SKIP=true: no Robust call and no grid lookup; a random UUID stands in for the PrincipalID. */
  robustSkip: boolean;
}
