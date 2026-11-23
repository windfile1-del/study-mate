import path from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import forge from 'node-forge';
import { atomicJson, readJson, SerialQueue } from './storage';
import { AppError } from './errors';
import type { PairCode, PairCredentials, RemoteDevice } from '../shared/remote';

const token = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) => {
  const x = Buffer.from(hash(a)),
    y = Buffer.from(hash(b));
  return timingSafeEqual(x, y);
};
interface DeviceRecord extends RemoteDevice {
  refreshHash: string;
  refreshExpires: number;
}
interface Identity {
  serverId: string;
  certificate: string;
  privateKey: string;
}
interface Pending {
  id: string;
  name: string;
  createdAt: string;
  expires: number;
  pollHash: string;
  approved: boolean;
  rejected: boolean;
  credentials?: PairCredentials;
}
export interface SecretProtection {
  encrypt(value: string): string;
  decrypt(value: string): string;
}
export type QrPairCode = Omit<PairCode, 'hostname' | 'certificate'>;

/**
 * The QR code only needs to anchor the TLS key. The mobile client receives the certificate from
 * the handshake and verifies its SPKI hash against `pin`; the full certificate remains available in
 * the manually copied pairing JSON for compatibility.
 */
export function qrPairCode(code: PairCode): QrPairCode {
  return {
    version: code.version,
    serverId: code.serverId,
    addresses: code.addresses,
    port: code.port,
    pin: code.pin,
    secret: code.secret,
    expiresAt: code.expiresAt,
  };
}

/** No Electron dependency: authentication can be tested against real TLS independently. */
export class RemoteAuth {
  private records: DeviceRecord[] = [];
  private accesses = new Map<string, { deviceId: string; expires: number }>();
  private waiting = new Map<string, Pending>();
  private code: PairCode | null = null;
  private queue = new SerialQueue();
  identity!: Identity;
  private file: string;
  constructor(
    private root: string,
    private protection: SecretProtection,
    private now = () => Date.now(),
  ) {
    this.file = path.join(root, 'devices.json');
  }
  async initialize() {
    const saved = await readJson<Identity | null>(path.join(this.root, 'identity.json'), null);
    if (saved) this.identity = { ...saved, privateKey: this.protection.decrypt(saved.privateKey) };
    else {
      const serverId = randomUUID(),
        keys = await new Promise<forge.pki.rsa.KeyPair>((resolve, reject) =>
          forge.pki.rsa.generateKeyPair({ bits: 2048, workers: 0 }, (e, k) => (e ? reject(e) : resolve(k))),
        );
      const certificate = forge.pki.createCertificate();
      certificate.publicKey = keys.publicKey;
      certificate.serialNumber = '01' + randomBytes(15).toString('hex');
      certificate.validity.notBefore = new Date(this.now() - 86400000);
      certificate.validity.notAfter = new Date(this.now() + 5 * 365 * 86400000);
      const attrs = [{ name: 'commonName', value: serverId + '.studymate.local' }];
      certificate.setSubject(attrs);
      certificate.setIssuer(attrs);
      certificate.setExtensions([
        { name: 'basicConstraints', cA: false },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: serverId + '.studymate.local' }] },
      ]);
      certificate.sign(keys.privateKey, forge.md.sha256.create());
      this.identity = {
        serverId,
        certificate: forge.pki.certificateToPem(certificate),
        privateKey: forge.pki.privateKeyToPem(keys.privateKey),
      };
      await atomicJson(path.join(this.root, 'identity.json'), {
        ...this.identity,
        privateKey: this.protection.encrypt(this.identity.privateKey),
      });
    }
    const cert = new X509Certificate(this.identity.certificate);
    if (cert.validToDate.getTime() < this.now())
      throw new AppError('IDENTITY_EXPIRED', '电脑证书已过期，请重新建立配对身份。');
    this.records = await readJson(this.file, []);
  }
  get hostname() {
    return this.identity ? this.identity.serverId + '.studymate.local' : '';
  }
  get pin() {
    return this.identity
      ? createHash('sha256')
          .update(
            new X509Certificate(this.identity.certificate).publicKey.export({ type: 'spki', format: 'der' }),
          )
          .digest('base64')
      : '';
  }
  devices() {
    return this.records.map(({ refreshHash, refreshExpires, ...device }) => ({ ...device }));
  }
  pending() {
    this.expire();
    return [...this.waiting.values()]
      .filter((p) => !p.rejected && !p.credentials)
      .map((p) => ({ id: p.id, name: p.name, createdAt: p.createdAt }));
  }
  issueCode(addresses: string[], port: number): PairCode {
    this.code = {
      version: 1,
      serverId: this.identity.serverId,
      hostname: this.hostname,
      addresses,
      port,
      certificate: new X509Certificate(this.identity.certificate).raw.toString('base64'),
      pin: this.pin,
      secret: token(),
      expiresAt: new Date(this.now() + 180000).toISOString(),
    };
    return structuredClone(this.code);
  }
  currentCode() {
    return this.code && Date.parse(this.code.expiresAt) > this.now() ? structuredClone(this.code) : null;
  }
  begin(secret: string, name: string) {
    this.expire();
    if (!this.code || Date.parse(this.code.expiresAt) <= this.now() || !equal(secret, this.code.secret))
      throw new AppError('PAIR_EXPIRED', '配对码无效或已过期，请在电脑生成新的二维码。');
    this.code = null;
    const pollToken = token(),
      id = randomUUID();
    this.waiting.set(id, {
      id,
      name,
      createdAt: new Date(this.now()).toISOString(),
      expires: this.now() + 180000,
      pollHash: hash(pollToken),
      approved: false,
      rejected: false,
    });
    return { pairingId: id, pollToken, status: 'pending' };
  }
  async approve(id: string, vaultId: string) {
    return this.queue.run(async () => {
      this.expire();
      const pending = this.waiting.get(id);
      if (!pending || pending.rejected) throw new AppError('PAIR_EXPIRED', '配对申请已过期。');
      if (pending.credentials) return;
      const device: DeviceRecord = {
        id: randomUUID(),
        name: pending.name,
        vaultId,
        createdAt: new Date(this.now()).toISOString(),
        lastSeenAt: new Date(this.now()).toISOString(),
        revoked: false,
        refreshHash: '',
        refreshExpires: 0,
      };
      const credentials = this.credentials(device);
      this.records.push(device);
      try {
        await atomicJson(this.file, this.records);
      } catch (e) {
        this.records.pop();
        this.accesses.delete(hash(credentials.accessToken));
        throw e;
      }
      pending.credentials = credentials;
      pending.approved = true;
    });
  }
  reject(id: string) {
    const p = this.waiting.get(id);
    if (p) p.rejected = true;
  }
  poll(id: string, pollToken: string) {
    this.expire();
    const p = this.waiting.get(id);
    if (!p || !equal(hash(pollToken), p.pollHash))
      throw new AppError('PAIR_EXPIRED', '配对申请已失效，请重新扫描。');
    if (p.rejected) return { status: 'rejected' };
    return p.credentials ? { status: 'approved', ...p.credentials } : { status: 'pending' };
  }
  private credentials(device: DeviceRecord): PairCredentials {
    const accessToken = token(),
      refreshToken = token(),
      expires = this.now() + 15 * 60000;
    device.refreshHash = hash(refreshToken);
    device.refreshExpires = this.now() + 90 * 86400000;
    this.accesses.set(hash(accessToken), { deviceId: device.id, expires });
    return { deviceId: device.id, accessToken, refreshToken, expiresAt: new Date(expires).toISOString() };
  }
  authenticate(bearer: string | undefined): RemoteDevice {
    this.expire();
    const key = bearer?.startsWith('Bearer ') ? bearer.slice(7) : '',
      access = this.accesses.get(hash(key));
    const device =
      access && access.expires > this.now()
        ? this.records.find((d) => d.id === access.deviceId && !d.revoked)
        : null;
    if (!device) throw new AppError('UNPAIRED', '连接授权已过期，请重新连接电脑。');
    device.lastSeenAt = new Date(this.now()).toISOString();
    const { refreshHash, refreshExpires, ...view } = device;
    return { ...view };
  }
  async refresh(refreshToken: string) {
    return this.queue.run(async () => {
      const device = this.records.find(
        (d) => !d.revoked && d.refreshExpires > this.now() && equal(d.refreshHash, hash(refreshToken)),
      );
      if (!device) throw new AppError('UNPAIRED', '连接授权已失效，请重新配对。');
      const previous = { ...device },
        result = this.credentials(device);
      try {
        await atomicJson(this.file, this.records);
      } catch (e) {
        Object.assign(device, previous);
        this.accesses.delete(hash(result.accessToken));
        throw e;
      }
      return result;
    });
  }
  async revoke(id: string) {
    return this.queue.run(async () => {
      const d = this.records.find((d) => d.id === id);
      if (!d) return;
      d.revoked = true;
      d.refreshHash = '';
      await atomicJson(this.file, this.records);
      for (const [k, a] of this.accesses) if (a.deviceId === id) this.accesses.delete(k);
      for (const p of this.waiting.values())
        if (p.credentials?.deviceId === id) {
          p.credentials = undefined;
          p.rejected = true;
        }
    });
  }
  async grant(id: string, vaultId: string) {
    return this.queue.run(async () => {
      const d = this.records.find((d) => d.id === id && !d.revoked);
      if (!d) throw new AppError('UNPAIRED', '设备已解除配对。');
      d.vaultId = vaultId;
      await atomicJson(this.file, this.records);
    });
  }
  clearSessions() {
    this.accesses.clear();
    this.waiting.clear();
    this.code = null;
  }
  private expire() {
    for (const [k, a] of this.accesses) if (a.expires <= this.now()) this.accesses.delete(k);
    for (const [k, p] of this.waiting) if (p.expires <= this.now()) this.waiting.delete(k);
  }
}
