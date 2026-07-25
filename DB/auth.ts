import { sign, verify, Secret, SignOptions } from 'jsonwebtoken';
import { StringValue } from 'ms';
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool, query, getDefaultOwnerId } from './db.js';
import { CONFIG } from './config.js';

const scrypt = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    _scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey as Buffer);
    });
  });

export interface AuthTokenPayload {
  sub: string;
  email: string;
  displayName: string;
  ownerId: string;
  roles: string[];
  canWriteBlockchain: boolean;
  iat?: number;
  exp?: number;
  iss?: string;
  jti?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  ownerId: string;
  status: string;
  roles: string[];
  canWriteBlockchain: boolean;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt);
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, key] = storedHash.split(':');
  const derived = await scrypt(password, salt);
  const hashedBuffer = Buffer.from(key, 'hex');
  return timingSafeEqual(hashedBuffer, derived);
}

export function generateAccessToken(payload: AuthTokenPayload): string {
  const secret: Secret = CONFIG.JWT_SECRET;
  const expiresIn = CONFIG.JWT_EXPIRY as StringValue;
  const options: SignOptions = {
    expiresIn,
    issuer: CONFIG.APP_NAME,
    jwtid: uuidv4(),
  };
  return sign(payload, secret, options);
}

export function verifyAccessToken(token: string): AuthTokenPayload {
  const secret: Secret = CONFIG.JWT_SECRET;
  return verify(token, secret) as AuthTokenPayload;
}

function parseRoles(rolesValue: string | null): string[] {
  if (!rolesValue) {
    return [];
  }
  return rolesValue.split(',').map((role) => role.trim()).filter(Boolean);
}

export async function getUserById(userId: string): Promise<AuthUser | null> {
  const rows = await query<any>(
    `SELECT u.id, u.email, u.display_name, u.owner_id, u.status,
      GROUP_CONCAT(r.role) AS roles,
      MAX(r.can_write_blockchain) AS can_write_blockchain
     FROM users u
     LEFT JOIN roles_permissions r ON r.user_id = u.id
     WHERE u.id = ?
     GROUP BY u.id, u.email, u.display_name, u.owner_id, u.status`,
    [userId]
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    ownerId: row.owner_id,
    status: row.status,
    roles: parseRoles(row.roles),
    canWriteBlockchain: Boolean(row.can_write_blockchain),
  };
}

export async function getUserByEmail(email: string): Promise<AuthUser | null> {
  const rows = await query<any>(
    `SELECT u.id, u.email, u.display_name, u.owner_id, u.status,
      GROUP_CONCAT(r.role) AS roles,
      MAX(r.can_write_blockchain) AS can_write_blockchain
     FROM users u
     LEFT JOIN roles_permissions r ON r.user_id = u.id
     WHERE u.email = ?
     GROUP BY u.id, u.email, u.display_name, u.owner_id, u.status`,
    [email]
  );

  if (rows.length === 0) {
    return null;
  }

  const row = rows[0];
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    ownerId: row.owner_id,
    status: row.status,
    roles: parseRoles(row.roles),
    canWriteBlockchain: Boolean(row.can_write_blockchain),
  };
}

export async function registerUser(options: {
  email: string;
  password: string;
  displayName: string;
  role?: string;
  ownerId?: string;
}): Promise<{ token: string; user: AuthUser }> {
  const { email, password, displayName, role = 'VIP_OWNER', ownerId } = options;

  const existing = await query<any>('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length > 0) {
    throw new Error('Ya existe un usuario con ese correo electrónico.');
  }

  const resolvedOwnerId = ownerId ? ownerId : await getDefaultOwnerId();
  const passwordHash = await hashPassword(password);
  const userId = uuidv4();

  await pool.execute(
    `INSERT INTO users (id, owner_id, display_name, email, password_hash, status)
     VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
    [userId, resolvedOwnerId, displayName, email, passwordHash]
  );

  const canWriteBlockchain = role === 'VIP_OWNER' || role === 'FLEET_MANAGER';

  await pool.execute(
    `INSERT INTO roles_permissions (id, user_id, role, can_write_blockchain)
     VALUES (?, ?, ?, ?)`,
    [uuidv4(), userId, role, canWriteBlockchain ? 1 : 0]
  );

  const authUser: AuthUser = {
    id: userId,
    email,
    displayName,
    ownerId: resolvedOwnerId,
    status: 'ACTIVE',
    roles: [role],
    canWriteBlockchain,
  };

  return {
    token: generateAccessToken({
      sub: authUser.id,
      email: authUser.email,
      displayName: authUser.displayName,
      ownerId: authUser.ownerId,
      roles: authUser.roles,
      canWriteBlockchain: authUser.canWriteBlockchain,
    }),
    user: authUser,
  };
}

export async function loginUser(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
  const rows = await query<any>(
    `SELECT u.id, u.email, u.display_name, u.owner_id, u.password_hash, u.status,
      GROUP_CONCAT(r.role) AS roles,
      MAX(r.can_write_blockchain) AS can_write_blockchain
     FROM users u
     LEFT JOIN roles_permissions r ON r.user_id = u.id
     WHERE u.email = ?
     GROUP BY u.id, u.email, u.display_name, u.owner_id, u.password_hash, u.status`,
    [email]
  );

  if (rows.length === 0) {
    throw new Error('Usuario o contraseña inválidos.');
  }

  const row = rows[0];
  const passwordMatches = await verifyPassword(password, row.password_hash);
  if (!passwordMatches) {
    throw new Error('Usuario o contraseña inválidos.');
  }

  const authUser: AuthUser = {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    ownerId: row.owner_id,
    status: row.status,
    roles: parseRoles(row.roles),
    canWriteBlockchain: Boolean(row.can_write_blockchain),
  };

  if (authUser.status !== 'ACTIVE') {
    throw new Error('El usuario no está activo.');
  }

  return {
    token: generateAccessToken({
      sub: authUser.id,
      email: authUser.email,
      displayName: authUser.displayName,
      ownerId: authUser.ownerId,
      roles: authUser.roles,
      canWriteBlockchain: authUser.canWriteBlockchain,
    }),
    user: authUser,
  };
}

export function issueVerifiableCredential(user: AuthUser): string {
  const credential = {
    '@context': ['https://www.w3.org/2018/credentials/v1'],
    id: `urn:uuid:${uuidv4()}`,
    type: ['VerifiableCredential', 'CarVaultAccessCredential'],
    issuer: CONFIG.APP_NAME,
    issuanceDate: new Date().toISOString(),
    credentialSubject: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      ownerId: user.ownerId,
      roles: user.roles,
      canWriteBlockchain: user.canWriteBlockchain,
    },
  };

  const secret: Secret = CONFIG.JWT_SECRET;
  const expiresIn = CONFIG.JWT_EXPIRY as StringValue;
  const options: SignOptions = {
    expiresIn,
    issuer: CONFIG.APP_NAME,
    jwtid: uuidv4(),
  };
  return sign(
    {
      vc: credential,
    },
    secret,
    options
  );
}

export function verifyVerifiableCredential(token: string): any {
  const secret: Secret = CONFIG.JWT_SECRET;
  return verify(token, secret);
}

export async function authenticateToken(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Token de autorización faltante o inválido.' });
      return;
    }

    const token = authHeader.replace('Bearer ', '').trim();
    const payload = verifyAccessToken(token);
    const user = await getUserById(payload.sub);

    if (!user) {
      res.status(401).json({ error: 'Token inválido o usuario no encontrado.' });
      return;
    }

    if (user.status !== 'ACTIVE') {
      res.status(403).json({ error: 'Usuario no autorizado.' });
      return;
    }

    req.user = user;
    next();
  } catch (error: any) {
    res.status(401).json({ error: error.message || 'Token inválido.' });
  }
}

export function authorizeRoles(allowedRoles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Usuario no autenticado.' });
      return;
    }

    const intersection = user.roles.filter((role) => allowedRoles.includes(role));
    if (intersection.length === 0) {
      res.status(403).json({ error: 'No tienes permisos para acceder a este recurso.' });
      return;
    }

    next();
  };
}
