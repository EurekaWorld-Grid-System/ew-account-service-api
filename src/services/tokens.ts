import jwt from 'jsonwebtoken';
import { CookieOptions } from 'express';

// Access and refresh tokens, copied from ew-portal-api (services/jwtService.ts). Same RS256 key
// pair as ew-portal-api during the migration (Pre-Launch Security Design §4.4), so tokens issued
// here are interchangeable with the ones ew-portal-api issues (its /auth/refresh accepts them).

export interface AccessTokenClaims {
  sub: string; // BMS UserId
  accountId: string;
  username: string;
  globalRole: string;
  organization: string;
  instituteId: string;
  isInitial: boolean;
}

export interface TokenConfig {
  privateKey: string;
  accessTokenExpiry: string; // e.g. '15m', '0.25h'
  refreshTokenExpiry: string; // e.g. '12h'
  cookieDomain?: string;
  secureCookies: boolean;
}

export const REFRESH_TOKEN_COOKIE = 'ewRefreshToken';

export class TokenIssuer {
  constructor(private readonly cfg: TokenConfig) {}

  signAccessToken(claims: AccessTokenClaims): string {
    return jwt.sign(claims, this.cfg.privateKey, {
      algorithm: 'RS256',
      expiresIn: this.cfg.accessTokenExpiry,
    } as jwt.SignOptions);
  }

  signRefreshToken(userId: string): string {
    return jwt.sign({ sub: userId, type: 'refresh' }, this.cfg.privateKey, {
      algorithm: 'RS256',
      expiresIn: this.cfg.refreshTokenExpiry,
    } as jwt.SignOptions);
  }

  /** Root-domain cookie (.eurekaworld.co.il) shared by all apps for cross-app silent refresh. */
  refreshCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.cfg.secureCookies,
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days, as in ew-portal-api
      path: '/',
      ...(this.cfg.cookieDomain ? { domain: this.cfg.cookieDomain } : {}),
    };
  }
}
