import fs from 'fs';
import path from 'path';
import { Gateway, Wallets, Contract } from 'fabric-network';
import { CONFIG } from './config.js';

const getConnectionProfile = (): any => {
  const profilePath = path.resolve(CONFIG.FABRIC.CONNECTION_PROFILE_PATH);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`Fabric connection profile no encontrado en ${profilePath}`);
  }

  const raw = fs.readFileSync(profilePath, 'utf8');
  return JSON.parse(raw);
};

export async function createFabricGateway(): Promise<Gateway> {
  const gateway = new Gateway();
  const walletPath = path.resolve(CONFIG.FABRIC.WALLET_PATH);
  const wallet = await Wallets.newFileSystemWallet(walletPath);

  const identity = CONFIG.FABRIC.USER_IDENTITY;
  const identityExists = await wallet.get(identity);
  if (!identityExists) {
    throw new Error(`Identity ${identity} no encontrada en wallet: ${walletPath}`);
  }

  const connectionProfile = getConnectionProfile();
  await gateway.connect(connectionProfile, {
    wallet,
    identity,
    discovery: { enabled: true, asLocalhost: CONFIG.FABRIC.PEER_HOST === 'localhost' },
  });

  return gateway;
}
