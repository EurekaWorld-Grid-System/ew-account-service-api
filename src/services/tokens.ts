import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { CookieOptions } from 'express';

// Access and refresh tokens, copied from ew-portal-api (services/jwtService.ts). Same RS256 key
// pair as ew-portal-api during the migration (Pre-Launch Security Design §4.4).
//
// 0.5.0: tokens belong to a server-side session (ew_system.auth_sessions):
//   access token  { ...claims, sid }              sid = session_id (POST /auth/verify checks it)
//   refresh token { sub, type: 'refresh', sid, jti }   jti = the session's current refresh_jti

export interface AccessTokenClaims {
  sub: string; // BMS UserId
  accountId: string;
  username: string;
  globalRole: string;
  organization: string;
  instituteId: string;
  isInitial: boolean;
}

export interface VerifiedAccessToken extends AccessTokenClaims {
  sid?: string;
  iat: number;
  exp: number;
}

export interface VerifiedRefreshToken {
  sub: string;
  type: string;
  sid?: string;
  jti?: string;
  exp: number;
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
  private readonly publicKey: string;
  private jwksCache: { keys: object[] } | null = null;

  constructor(private readonly cfg: TokenConfig) {
    this.publicKey = crypto.createPublicKey(cfg.privateKey).export({ type: 'spki', format: 'pem' }).toString();
  }

  signAccessToken(claims: AccessTokenClaims & { sid: string }): string {
    return jwt.sign(claims, this.cfg.privateKey, {
      algorithm: 'RS256',
      expiresIn: this.cfg.accessTokenExpiry,
    } as jwt.SignOptions);
  }

  /** The token and how long it lives (the session's expiry slides by the same amount). */
  signRefreshToken(userId: string, sessionId: string, jti: string): { token: string; ttlSeconds: number } {
    const token = jwt.sign({ sub: userId, type: 'refresh', sid: sessionId }, this.cfg.privateKey, {
      algorithm: 'RS256',
      expiresIn: this.cfg.refreshTokenExpiry,
      jwtid: jti,
    } as jwt.SignOptions);
    const { exp, iat } = jwt.decode(token) as { exp: number; iat: number };
    return { token, ttlSeconds: Math.max(1, exp - iat) };
  }

  /** Throws jsonwebtoken's TokenExpiredError / JsonWebTokenError. */
  verifyAccessToken(token: string): VerifiedAccessToken {
    const payload = jwt.verify(token, this.publicKey, { algorithms: ['RS256'] }) as VerifiedAccessToken & { type?: string };
    // As in ew-portal-api: a refresh token (same key, type 'refresh') must not pass as an access token
    if (payload.type !== undefined && payload.type !== 'access') {
      const e = new Error('Token type is not access');
      e.name = 'JsonWebTokenError';
      throw e;
    }
    return payload;
  }

  /** Throws jsonwebtoken's TokenExpiredError / JsonWebTokenError. */
  verifyRefreshToken(token: string): VerifiedRefreshToken {
    return jwt.verify(token, this.publicKey, { algorithms: ['RS256'] }) as VerifiedRefreshToken;
  }

  /** Same document (and kid) as ew-portal-api getJwks(). */
  jwks(): { keys: object[] } {
    if (this.jwksCache) return this.jwksCache;
    const jwk = crypto.createPublicKey(this.publicKey).export({ format: 'jwk' });
    const kid = crypto.createHash('sha256').update(JSON.stringify(jwk)).digest('base64url');
    this.jwksCache = { keys: [{ ...jwk, use: 'sig', alg: 'RS256', kid }] };
    return this.jwksCache;
  }

  /** Root-domain cookie (.eurekaworld.co.il) shared by all apps for cross-app silent refresh. */
  refreshCookieOptions(): CookieOptions {
    return { ...this.clearCookieOptions(), maxAge: 7 * 24 * 60 * 60 * 1000 }; // 7 days, as in ew-portal-api
  }

  clearCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.cfg.secureCookies,
      sameSite: 'strict',
      path: '/',
      ...(this.cfg.cookieDomain ? { domain: this.cfg.cookieDomain } : {}),
    };
  }
}
