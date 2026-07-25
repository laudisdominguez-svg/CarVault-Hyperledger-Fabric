import mysql from 'mysql2/promise';
import { RowDataPacket } from 'mysql2/promise';
import { CONFIG } from './config.js';



export const pool = mysql.createPool({
  host: CONFIG.MYSQL.HOST,
  port: CONFIG.MYSQL.PORT,
  database: CONFIG.MYSQL.DATABASE,
  user: CONFIG.MYSQL.USER,
  password: CONFIG.MYSQL.PASSWORD,
  waitForConnections: true,
  connectionLimit: CONFIG.MYSQL.POOL_SIZE,
  queueLimit: 0,
  decimalNumbers: true,
});

export async function query<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return rows as T[];
}

export async function getDefaultOwnerId(): Promise<string> {
  const rows = await query<{ id: string }>('SELECT id FROM owners LIMIT 1');
  if (rows.length > 0) {
    return rows[0].id;
  }

  await pool.execute(
    `INSERT INTO owners (name, contact_email) VALUES (?, ?)`,
    ['Default Vault Owner', 'default@carvault.local']
  );

  const newRows = await query<{ id: string }>(
    'SELECT id FROM owners WHERE contact_email = ? LIMIT 1',
    ['default@carvault.local']
  );

  return newRows[0].id;
}
